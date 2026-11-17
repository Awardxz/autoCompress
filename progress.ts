/*
 * AutoCompress, a Vencord plugin
 * Copyright (c) 2026 AutoCompress contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A small floating panel with one progress bar per video being compressed.
// Plain DOM (no Discord internals) so it keeps working across Discord updates.

import type { JobStatus } from "./native";

const cl = (name: string) => `vc-autocompress-${name}`;

let container: HTMLDivElement | null = null;
const rows = new Set<ProgressRow>();

function getContainer() {
    if (!container || !container.isConnected) {
        container = document.createElement("div");
        container.className = cl("panel");
        container.setAttribute("role", "status");
        container.setAttribute("aria-live", "polite");
        document.body.appendChild(container);
    }
    return container;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
    const e = document.createElement(tag);
    e.className = cl(className);
    if (text != null) e.textContent = text;
    return e;
}

function fmtTime(secs: number) {
    if (!Number.isFinite(secs) || secs < 0) return "";
    secs = Math.ceil(secs);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
}

function stageLabel({ stage, attempt }: JobStatus) {
    const retry = attempt > 1 ? `Retry ${attempt - 1} · ` : "";
    switch (stage) {
        case "reading": return "Reading video…";
        case "pass1": return `${retry}Pass 1 of 2 · analyzing`;
        case "pass2": return `${retry}Pass 2 of 2 · encoding`;
        case "done": return "Finishing…";
        default: return "Compressing…";
    }
}

export class ProgressRow {
    private root = el("div", "row");
    private fill = el("div", "fill");
    private status = el("span", "status", "Preparing…");
    private pct = el("span", "pct", "");
    private closeBtn = el("button", "close", "✕");

    private finished = false;
    private etaStart = 0;
    private etaFrom = 0;
    private lastAttempt = 1;

    constructor(fileName: string, detail: string, onCancel: () => void) {
        const head = el("div", "head");
        const name = el("span", "name", fileName);
        name.title = fileName;
        const sub = el("span", "detail", detail);

        this.closeBtn.type = "button";
        this.closeBtn.title = "Cancel";
        this.closeBtn.setAttribute("aria-label", `Cancel compressing ${fileName}`);
        this.closeBtn.onclick = () => {
            if (this.finished) this.remove();
            else onCancel();
        };

        const titles = el("div", "titles");
        titles.append(name, sub);
        head.append(titles, this.closeBtn);

        const bar = el("div", "bar");
        bar.setAttribute("role", "progressbar");
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", "100");
        bar.appendChild(this.fill);

        const meta = el("div", "meta");
        meta.append(this.status, this.pct);

        this.root.append(head, bar, meta);
        getContainer().appendChild(this.root);
        rows.add(this);
        this.root.classList.add(cl("indeterminate"));
    }

    update(s: JobStatus) {
        if (this.finished) return;

        // Guard against bad data (e.g. Discord's main process still running an older native.ts).
        if (!Number.isFinite(s.progress)) s = { ...s, progress: 0, stage: "reading" };

        const p = Math.max(0, Math.min(1, s.progress));
        const now = performance.now();

        // Restart the ETA clock when encoding starts or a retry begins.
        if (s.stage === "reading") {
            this.etaStart = 0;
        } else if (!this.etaStart || s.attempt !== this.lastAttempt) {
            this.etaStart = now;
            this.etaFrom = p;
        }
        this.lastAttempt = s.attempt;

        const working = s.stage !== "reading";
        this.root.classList.toggle(cl("indeterminate"), !working);
        this.fill.style.width = working ? `${(p * 100).toFixed(1)}%` : "";
        this.root.querySelector(`.${cl("bar")}`)!.setAttribute("aria-valuenow", String(Math.round(p * 100)));

        this.status.textContent = stageLabel(s);

        let text = working ? `${Math.floor(p * 100)}%` : "";
        const done = p - this.etaFrom;
        if (working && this.etaStart && done > 0.03) {
            const elapsed = (now - this.etaStart) / 1000;
            const left = fmtTime(elapsed * (1 - p) / done);
            if (left) text += ` · ${left} left`;
        }
        this.pct.textContent = text;
    }

    succeed(text: string) {
        this.end("success", text, 3000);
        this.fill.style.width = "100%";
    }

    fail(text: string) {
        this.end("error", text, 10000);
    }

    cancelled() {
        this.end("error", "Cancelled", 1500);
    }

    private end(kind: "success" | "error", text: string, removeAfter: number) {
        if (this.finished) return;
        this.finished = true;
        this.root.classList.remove(cl("indeterminate"));
        this.root.classList.add(cl(kind));
        this.status.textContent = text;
        this.status.title = text;
        this.pct.textContent = "";
        this.closeBtn.title = "Dismiss";
        this.closeBtn.setAttribute("aria-label", "Dismiss");
        setTimeout(() => this.remove(), removeAfter);
    }

    remove() {
        if (!rows.delete(this)) return;
        this.root.classList.add(cl("leaving"));
        setTimeout(() => {
            this.root.remove();
            if (!rows.size) {
                container?.remove();
                container = null;
            }
        }, 200);
    }
}

export function removeAllRows() {
    for (const row of [...rows]) row.remove();
    container?.remove();
    container = null;
}
