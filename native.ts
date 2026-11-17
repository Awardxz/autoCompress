/*
 * AutoCompress, a Vencord plugin
 * Copyright (c) 2026 AutoCompress contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Runs in Discord's main (Node/Electron) process. The renderer sends the video
// bytes over IPC; we write them to a temp dir, run a two-pass ffmpeg encode
// aimed at the target size, and send the result back.

import { ChildProcess, spawn } from "child_process";
import { IpcMainInvokeEvent } from "electron";
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { devNull, tmpdir } from "os";
import { basename, join } from "path";

const PRESETS = new Set(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"]);
const FFMPEG_NAME = /^ffmpeg(\.exe)?$/i;

// Leave room for container overhead and bitrate drift.
const SIZE_SAFETY = 0.94;
const MIN_VIDEO_KBPS = 40;
const MAX_ATTEMPTS = 3;

export type Stage = "reading" | "pass1" | "pass2" | "done";

interface Job {
    progress: number;
    stage: Stage;
    attempt: number;
    proc?: ChildProcess;
    cancelled: boolean;
}

export interface JobStatus {
    progress: number;
    stage: Stage;
    attempt: number;
}

const jobs = new Map<string, Job>();

export interface CompressOptions {
    ffmpegPath: string;
    targetBytes: number;
    preset: string;
}

export interface CompressResult {
    ok: true;
    data: Uint8Array;
    size: number;
    attempts: number;
}

export interface CompressError {
    ok: false;
    error: string;
}

class UserError extends Error { }

function validate(opts: CompressOptions) {
    const ffmpegPath = (opts.ffmpegPath || "ffmpeg").trim();
    // Only ever spawn something that is actually called ffmpeg, so this IPC
    // handler can't be abused to launch arbitrary executables.
    if (!FFMPEG_NAME.test(basename(ffmpegPath)))
        throw new UserError("The ffmpeg path must point to an executable named ffmpeg (or ffmpeg.exe).");

    const targetBytes = Number(opts.targetBytes);
    if (!Number.isFinite(targetBytes) || targetBytes < 512 * 1024)
        throw new UserError("Target size must be at least 0.5 MB.");

    const preset = PRESETS.has(opts.preset) ? opts.preset : "faster";
    return { ffmpegPath, targetBytes, preset };
}

function run(bin: string, args: string[], job: Job, onStdoutLine?: (line: string) => void) {
    return new Promise<{ code: number | null; stderr: string; }>((resolve, reject) => {
        if (job.cancelled) return reject(new UserError("Cancelled."));

        const proc = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        job.proc = proc;

        let stderr = "";
        let buf = "";
        proc.stderr.on("data", d => {
            stderr += d;
            if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
        });
        proc.stdout.on("data", d => {
            if (!onStdoutLine) return;
            buf += d;
            let i: number;
            while ((i = buf.indexOf("\n")) !== -1) {
                onStdoutLine(buf.slice(0, i).trim());
                buf = buf.slice(i + 1);
            }
        });
        proc.on("error", (err: NodeJS.ErrnoException) => {
            job.proc = undefined;
            reject(err.code === "ENOENT"
                ? new UserError("ffmpeg was not found. Install it and add it to PATH, or set its full path in the AutoCompress settings.")
                : err);
        });
        proc.on("close", code => {
            job.proc = undefined;
            if (job.cancelled) return reject(new UserError("Cancelled."));
            resolve({ code, stderr });
        });
    });
}

interface ProbeInfo {
    duration: number;
    hasAudio: boolean;
    height: number | null;
}

async function probe(ffmpeg: string, input: string, job: Job): Promise<ProbeInfo> {
    // `ffmpeg -i file` with no output exits non-zero but prints stream info,
    // which saves us from also needing ffprobe.
    const { stderr } = await run(ffmpeg, ["-hide_banner", "-nostdin", "-i", input], job);

    const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
    if (!d) throw new UserError("Couldn't read the video's duration. Is this a valid video file?");
    const duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
    if (!(duration > 0)) throw new UserError("The video has no duration.");

    const videoLine = /Stream #\S+.*?Video:.*/.exec(stderr)?.[0] ?? "";
    const res = /\b(\d{2,5})x(\d{2,5})\b/.exec(videoLine);

    return {
        duration,
        hasAudio: /Stream #\S+.*?Audio:/.test(stderr),
        height: res ? Number(res[2]) : null,
    };
}

function pickAudioKbps(totalKbps: number, hasAudio: boolean) {
    if (!hasAudio) return 0;
    if (totalKbps >= 1000) return 128;
    if (totalKbps >= 400) return 96;
    if (totalKbps >= 150) return 64;
    return 32;
}

function pickMaxHeight(videoKbps: number) {
    if (videoKbps >= 4000) return 1080;
    if (videoKbps >= 1800) return 720;
    if (videoKbps >= 800) return 480;
    if (videoKbps >= 400) return 360;
    return 240;
}

export async function compress(
    _: IpcMainInvokeEvent,
    jobId: string,
    input: Uint8Array,
    fileName: string,
    rawOpts: CompressOptions
): Promise<CompressResult | CompressError> {
    const job: Job = { progress: 0, stage: "reading", attempt: 1, cancelled: false };
    jobs.set(jobId, job);

    let dir: string | undefined;
    try {
        const { ffmpegPath, targetBytes, preset } = validate(rawOpts);

        dir = await mkdtemp(join(tmpdir(), "vc-autocompress-"));
        const ext = /\.[a-z0-9]{1,5}$/i.exec(fileName)?.[0] ?? ".mp4";
        const inPath = join(dir, "input" + ext);
        const outPath = join(dir, "output.mp4");
        const passLog = join(dir, "pass");
        await writeFile(inPath, input);

        const info = await probe(ffmpegPath, inPath, job);

        const totalKbps = (targetBytes * 8 * SIZE_SAFETY) / 1000 / info.duration;
        const audioKbps = pickAudioKbps(totalKbps, info.hasAudio);
        let videoKbps = Math.floor(totalKbps - audioKbps);

        if (videoKbps < MIN_VIDEO_KBPS) {
            const maxSecs = Math.floor((targetBytes * 8 * SIZE_SAFETY) / 1000 / (MIN_VIDEO_KBPS + audioKbps));
            throw new UserError(`This video is too long to fit in ${(targetBytes / 1024 / 1024).toFixed(0)} MB at watchable quality (max ~${maxSecs}s).`);
        }

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            job.attempt = attempt;
            const maxH = pickMaxHeight(videoKbps);
            const filters: string[] = [];
            if (info.height == null || info.height > maxH)
                filters.push(`scale=-2:trunc(min(ih\\,${maxH})/2)*2`);

            const common = [
                "-hide_banner", "-nostdin", "-y",
                "-i", inPath,
                "-map", "0:v:0",
                "-c:v", "libx264",
                "-preset", preset,
                "-b:v", `${videoKbps}k`,
                "-pix_fmt", "yuv420p",
                ...(videoKbps < 1500 ? ["-fpsmax", "30"] : []),
                ...(filters.length ? ["-vf", filters.join(",")] : []),
                "-passlogfile", passLog,
                "-progress", "pipe:1", "-nostats", "-loglevel", "error",
            ];

            for (const pass of [1, 2] as const) {
                job.stage = pass === 1 ? "pass1" : "pass2";
                const args = pass === 1
                    ? [...common, "-pass", "1", "-an", "-f", "null", devNull]
                    : [
                        ...common, "-pass", "2",
                        ...(audioKbps > 0
                            ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", `${audioKbps}k`, "-ac", "2"]
                            : ["-an"]),
                        "-movflags", "+faststart",
                        outPath,
                    ];

                const { code, stderr } = await run(ffmpegPath, args, job, line => {
                    const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
                    if (!m) return;
                    const p = Math.min(1, Number(m[1]) / 1e6 / info.duration);
                    job.progress = Math.min(0.999, (pass - 1 + p) / 2);
                });

                if (code !== 0) {
                    const tail = stderr.trim().split("\n").slice(-3).join(" ");
                    throw new UserError(`ffmpeg failed (pass ${pass}): ${tail || `exit code ${code}`}`);
                }
            }

            const { size } = await stat(outPath);
            if (size <= targetBytes) {
                job.progress = 1;
                job.stage = "done";
                const data = await readFile(outPath);
                return { ok: true, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), size, attempts: attempt };
            }

            // Overshot: scale the bitrate down by how much we missed and retry.
            videoKbps = Math.floor(videoKbps * (targetBytes / size) * 0.93);
            if (videoKbps < MIN_VIDEO_KBPS) break;
            job.progress = 0;
        }

        throw new UserError("Couldn't get the video under the size limit.");
    } catch (e) {
        return { ok: false, error: e instanceof UserError ? e.message : `Unexpected error: ${String(e)}` };
    } finally {
        jobs.delete(jobId);
        if (dir) rm(dir, { recursive: true, force: true }).catch(() => { });
    }
}

export function getProgress(_: IpcMainInvokeEvent, jobId: string): JobStatus | null {
    const job = jobs.get(jobId);
    return job ? { progress: job.progress, stage: job.stage, attempt: job.attempt } : null;
}

export function cancel(_: IpcMainInvokeEvent, jobId?: string) {
    const targets = jobId ? [jobs.get(jobId)] : [...jobs.values()];
    for (const job of targets) {
        if (!job) continue;
        job.cancelled = true;
        job.proc?.kill();
    }
}

export async function checkFfmpeg(_: IpcMainInvokeEvent, ffmpegPath: string): Promise<string | null> {
    const path = (ffmpegPath || "ffmpeg").trim();
    if (!FFMPEG_NAME.test(basename(path))) return null;
    try {
        const { stderr, code } = await new Promise<{ code: number | null; stderr: string; }>((resolve, reject) => {
            const p = spawn(path, ["-hide_banner", "-version"], { windowsHide: true });
            let out = "";
            p.stdout.on("data", d => out += d);
            p.on("error", reject);
            p.on("close", c => resolve({ code: c, stderr: out }));
        });
        return code === 0 ? stderr.split("\n")[0].trim() : null;
    } catch {
        return null;
    }
}
