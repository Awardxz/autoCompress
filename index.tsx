/*
 * AutoCompress, a Vencord plugin
 * Copyright (c) 2026 AutoCompress contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import { GuildStore, showToast, UploadHandler, UserStore } from "@webpack/common";

import { ProgressRow, removeAllRows } from "./progress";
import managedStyle from "./styles.css?managed";

const Native = VencordNative.pluginHelpers.AutoCompress as PluginNative<typeof import("./native")>;
const logger = new Logger("AutoCompress");

const MiB = 1024 * 1024;
// Discord's effective upload limit is never below 20 MiB: its client checks
// `Math.max(0x1400000, userOrGuildLimit)`, even though free accounts report 10 MiB.
const FREE_LIMIT = 20 * MiB;
const GUILD_LIMITS: [feature: string, bytes: number][] = [
    ["MAX_FILE_SIZE_100_MB", 100 * MiB],
    ["MAX_FILE_SIZE_50_MB", 50 * MiB],
];

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|ts|mts|m2ts|3gp|mpe?g)$/i;

const PremiumUtils: { getUserMaxFileSize?(user: unknown): number; } = findByPropsLazy("getUserMaxFileSize");

const settings = definePluginSettings({
    targetSizeMb: {
        type: OptionType.NUMBER,
        description: "Target size in MB for compressed videos. 0 = use your Discord upload limit (20 MB without Nitro).",
        default: 0,
    },
    preset: {
        type: OptionType.SELECT,
        description: "Encoding speed. Slower presets look slightly better at the same size.",
        options: [
            { label: "Ultra fast (lowest quality)", value: "ultrafast" },
            { label: "Very fast", value: "veryfast" },
            { label: "Faster (recommended)", value: "faster", default: true },
            { label: "Medium", value: "medium" },
            { label: "Slow (best quality)", value: "slow" },
        ],
    },
    ffmpegPath: {
        type: OptionType.STRING,
        description: "Path to ffmpeg. Leave as \"ffmpeg\" if it's on your PATH, otherwise use the full path, e.g. C:\\ffmpeg\\bin\\ffmpeg.exe",
        default: "ffmpeg",
    },
    showProgress: {
        type: OptionType.BOOLEAN,
        description: "Show a progress bar (with a cancel button) while compressing.",
        default: true,
    },
});

function getUploadLimit(guildId: string | null | undefined) {
    let limit = FREE_LIMIT;
    try {
        const userLimit = PremiumUtils.getUserMaxFileSize?.(UserStore.getCurrentUser());
        if (typeof userLimit === "number" && userLimit > limit) limit = userLimit;
    } catch (e) {
        logger.warn("Couldn't read the user upload limit, assuming 20 MB", e);
    }

    const features = guildId ? GuildStore.getGuild(guildId)?.features : null;
    if (features) {
        for (const [feature, bytes] of GUILD_LIMITS) {
            if (features.has(feature as any) && bytes > limit) limit = bytes;
        }
    }
    return limit;
}

function getTargetBytes(limit: number) {
    const custom = settings.store.targetSizeMb;
    return custom > 0 ? Math.min(custom * MiB, limit) : limit;
}

const isVideo = (f: File) => f.type.startsWith("video/") || VIDEO_EXT.test(f.name);
const fmtMb = (bytes: number) => `${(bytes / MiB).toFixed(1)} MB`;

function toast(text: string, variant: "default" | "success" | "critical" = "default", duration = 3000) {
    try {
        showToast({ text, variant, duration });
    } catch {
        logger.info(text);
    }
}

async function compressFile(file: File, targetBytes: number): Promise<File | null> {
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let cancelled = false;

    const row = settings.store.showProgress
        ? new ProgressRow(file.name, `${fmtMb(file.size)} → under ${fmtMb(targetBytes)}`, () => {
            cancelled = true;
            Native.cancel(jobId).catch(() => { });
        })
        : null;

    // Without the progress panel, errors still need to be visible somewhere.
    const reportError = (msg: string) => row ? row.fail(msg) : toast(`AutoCompress: ${msg}`, "critical", 6000);

    let polling = false;
    const poll = row
        ? setInterval(async () => {
            if (polling) return;
            polling = true;
            try {
                const status: unknown = await Native.getProgress(jobId);
                // Older native.ts returned a bare number; Discord keeps that loaded until a full restart.
                if (typeof status === "number") row.update({ progress: status, stage: status < 0.5 ? "pass1" : "pass2", attempt: 1 });
                else if (status) row.update(status as NonNullable<Awaited<ReturnType<typeof Native.getProgress>>>);
            } catch { } finally {
                polling = false;
            }
        }, 250)
        : null;

    try {
        const input = new Uint8Array(await file.arrayBuffer());
        if (cancelled) {
            row?.cancelled();
            return null;
        }

        const res = await Native.compress(jobId, input, file.name, {
            ffmpegPath: settings.store.ffmpegPath,
            targetBytes,
            preset: settings.store.preset,
        });

        if (cancelled) {
            row?.cancelled();
            return null;
        }
        if (!res.ok) {
            reportError(res.error);
            return null;
        }

        row?.succeed(`Done · ${fmtMb(file.size)} → ${fmtMb(res.size)}`);
        const name = file.name.replace(/\.[^.]+$/, "") + ".mp4";
        return new File([res.data as Uint8Array<ArrayBuffer>], name, { type: "video/mp4" });
    } catch (e) {
        logger.error("Compression failed", e);
        reportError("Compression failed. See the console (Ctrl+Shift+I) for details.");
        return null;
    } finally {
        if (poll) clearInterval(poll);
    }
}

interface UploadOptions {
    filesMetadata?: unknown[];
    [key: string]: unknown;
}

async function compressAndUpload(files: File[], limit: number, channel: Channel, draftType: number, options?: UploadOptions) {
    const targetBytes = getTargetBytes(limit);
    const keptFiles: File[] = [];
    const keptMeta: unknown[] = [];

    // One at a time: ffmpeg already uses every core.
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const out = isVideo(file) && file.size > limit
            ? await compressFile(file, targetBytes)
            : file;
        if (!out) continue;

        keptFiles.push(out);
        keptMeta.push(options?.filesMetadata?.[i]);
    }

    if (!keptFiles.length) return;

    const newOptions = options?.filesMetadata
        ? { ...options, filesMetadata: keptMeta }
        : options;

    // Vencord types promptToUpload with 3 params; Discord's takes an optional 4th options object.
    (UploadHandler.promptToUpload as (...args: unknown[]) => void)(keptFiles, channel, draftType, newOptions);
}

export default definePlugin({
    name: "AutoCompress",
    description: "Uses ffmpeg to automatically compress videos that are over your upload limit so they fit.",
    authors: [{ name: "AutoCompress contributors", id: 0n }],
    tags: ["Media", "Utility"],
    settings,
    managedStyle,

    patches: [
        {
            // Discord's promptToUpload: every upload (drag & drop, paste, the + button)
            // goes through it, and it's where Discord does the "file too large" check.
            find: "Unexpected mismatch between files and file metadata",
            replacement: {
                match: /async function\(\i,\i,\i\)\{(?=let\{filesMetadata)/,
                replace: "$&if($self.interceptUpload(arguments))return;",
            },
        },
    ],

    // Returns true when we've taken over the upload (Discord's flow is skipped).
    interceptUpload(args: IArguments): boolean {
        try {
            const [rawFiles, channel, draftType, options] = args as unknown as [ArrayLike<File>, Channel, number, UploadOptions?];
            if (!rawFiles || !channel) return false;

            const files = Array.from(rawFiles);
            const limit = getUploadLimit(channel.getGuildId?.() ?? channel.guild_id);
            if (!files.some(f => isVideo(f) && f.size > limit)) return false;

            void compressAndUpload(files, limit, channel, draftType, options);
            return true;
        } catch (e) {
            logger.error("interceptUpload failed, falling back to Discord's default", e);
            return false;
        }
    },

    async start() {
        const version = await Native.checkFfmpeg(settings.store.ffmpegPath).catch(() => null);
        if (version) logger.info(`Using ${version}`);
        else toast("AutoCompress: ffmpeg not found. Install it or set its path in the plugin settings.", "critical", 8000);
    },

    stop() {
        Native.cancel().catch(() => { });
        removeAllRows();
    },
});
