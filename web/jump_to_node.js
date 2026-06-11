// ComfyUI-JumpToNode
// A small front-end extension that makes it easy to find a specific node by ID,
// and to cycle through nodes the backend has complained about.
//
// Features:
//   1. Ctrl+Alt+J - opens a floating search dialog. Pre-fills with most recent
//      error node if one exists.
//   2. Alt+]  - jump to the next (newer) errored node in history
//      Alt+[  - jump to the previous (older) errored node in history
//      The error history dedups consecutive duplicates and captures every node
//      id reported in each validation traceback, not just the first.
//   3. Ctrl+Alt+E - jump straight to the most recent error.
//   4. Accepts plain IDs ("110"), subgraph paths ("82:485", "15:371:435"), and
//      tolerates the "#" prefix copy-pasted from console error messages.
//   5. Command palette entries and canvas right-click menu entries mirror the
//      hotkeys.
//   6. Left sidebar tab (magnifying glass icon, near the bottom below
//      Templates) - clicking it opens the Jump dialog directly. For users
//      who prefer a mouse click to a three-key chord.
//
// Install:
//   D:\ComfyUI\custom_nodes\ComfyUI-JumpToNode\
//       __init__.py
//       web\jump_to_node.js
// Restart Comfy, hard-reload the browser (Ctrl+F5).

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXT_NAME = "comfy.jump.to.node";
const HOTKEY_DESC = "Ctrl+Alt+J";

// --------------------------------------------------------------------------
// Persistent settings (localStorage). Three toggleable behaviors:
//   - openDialogFromSidebar : whether clicking the left sidebar tab also pops
//     the floating dialog. Default OFF -- the panel is fully usable on its own.
//   - autoJumpOnError       : whether to auto-jump to the first errored node
//     when a queue attempt fails. Default OFF -- conservative; flash + toast
//     are still shown when enabled. Independent of cycle hotkeys.
//   - toastDurationMs       : how long the bottom toast stays visible.
// Stored under a namespaced key so we don't clash with anything else.
// --------------------------------------------------------------------------
const SETTINGS_KEY = "comfy.jump.to.node.settings.v1";
const DEFAULT_SETTINGS = {
    openDialogFromSidebar: false,
    autoJumpOnError: false,
    toastDurationMs: 9000,
    consoleLogging: false,
};
function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return { ...DEFAULT_SETTINGS };
        const parsed = JSON.parse(raw);
        return { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
    } catch (_) {
        return { ...DEFAULT_SETTINGS };
    }
}
function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (_) {}
}
const settings = loadSettings();

// Informational logging. console.log only when the "Log to browser console"
// setting is ticked; otherwise console.debug, which Chrome/Firefox hide
// unless the devtools log level is set to Verbose. Warnings about real
// problems still use console.warn unconditionally.
function jtnLog(...args) {
    if (settings.consoleLogging) console.log(...args);
    else console.debug(...args);
}

// --------------------------------------------------------------------------
// Error history: an array of { nodeId, message, kind, at } entries, oldest
// first. cursor is the index most recently landed on (-1 = no position).
// --------------------------------------------------------------------------
const HISTORY_MAX = 200;          // hard cap so memory doesn't grow forever
const errorHistory = [];
let cursor = -1;                  // position in errorHistory

// Assigned by the sidebar tab's render() so rememberError() can refresh
// the recent-errors list in-place when new errors come in. No-op if the
// sidebar hasn't been opened yet.
let sidebarRefresh = null;

function getLastError() {
    if (!errorHistory.length) return null;
    return errorHistory[errorHistory.length - 1];
}

function rememberError(nodeId, message, kind) {
    if (nodeId == null) return;
    const normId = String(nodeId).replace(/^#/, "").trim();
    if (!normId) return;

    // Dedup vs the immediately prior entry: if the same node+message fires
    // twice in a row, don't bloat the list. A repeat from a later moment is
    // kept, because it's a genuinely new event.
    const prev = errorHistory[errorHistory.length - 1];
    if (prev && prev.nodeId === normId && prev.message === (message || null)) {
        return;
    }

    errorHistory.push({
        nodeId: normId,
        message: message || null,
        kind: kind || "error",
        at: Date.now(),
    });

    // Trim old entries from the front if we blow past the cap
    while (errorHistory.length > HISTORY_MAX) errorHistory.shift();

    // A new error always repositions the cursor to the end, so a subsequent
    // "prev" press walks backward through time from the freshest entry.
    cursor = errorHistory.length - 1;

    jtnLog(`[JumpToNode] error[${errorHistory.length - 1}] '${normId}': ${message || ""} (${kind || "error"})`);

    // If the sidebar is showing, refresh its list so the new error appears.
    if (sidebarRefresh) { try { sidebarRefresh(); } catch (_) {} }

    // Optional: auto-jump to the first errored node in this batch. We coalesce
    // multi-error /prompt responses so we only jump once per error event,
    // not 12 times in a row when 12 samplers all complain.
    if (settings.autoJumpOnError) scheduleAutoJump();
}

// Debounced auto-jump. Validation responses arrive synchronously in a tight
// loop (one rememberError per node_errors entry), so we set a 0-ms timer that
// fires after the loop unwinds and jumps to whatever ended up as the newest
// error. Only one jump per batch.
let _autoJumpTimer = null;
function scheduleAutoJump() {
    if (_autoJumpTimer) return;
    _autoJumpTimer = setTimeout(() => {
        _autoJumpTimer = null;
        try { jumpToLatestError(); } catch (e) { console.warn("[JumpToNode] auto-jump failed:", e); }
    }, 0);
}

function extractAllNodeErrors(nodeErrors) {
    if (!nodeErrors || typeof nodeErrors !== "object") return [];
    const results = [];
    for (const id of Object.keys(nodeErrors)) {
        const entry = nodeErrors[id];
        const errs = entry?.errors;
        if (Array.isArray(errs) && errs.length) {
            // Record one history entry per distinct error on that node
            for (const e of errs) {
                results.push({ id, msg: e?.message || entry?.message || "validation error" });
            }
        } else {
            results.push({ id, msg: entry?.message || "validation error" });
        }
    }
    return results;
}

// Single-error flat response shapes. ComfyUI introduced these around mid-2025
// for validation failures that aren't tied to per-node node_errors maps -- e.g.
// missing_node_type when a custom node is uninstalled but referenced in a
// loaded workflow. Shape:
//   { type: "missing_node_type",
//     message: "Node 'Toggle Input Images' has no class_type...",
//     details: "Node ID '#60'",
//     extra_info: { node_id: "60", class_type: null, node_title: "..." } }
//
// Also handles the related variant where the same payload arrives as the
// outer { error: { ... }, node_errors: {} } structure that some builds emit.
//
// Returns an array of { id, msg } so we can plug into the same rememberError
// loop the per-node path uses.
function extractFlatError(payload) {
    if (!payload || typeof payload !== "object") return [];
    // Normalize: payload might be the error object itself, or a wrapper
    // { error: {...} } / { error: "string" }
    const candidates = [];
    if (payload.type || payload.message || payload.details || payload.extra_info) {
        candidates.push(payload);
    }
    if (payload.error && typeof payload.error === "object") {
        candidates.push(payload.error);
    }
    const results = [];
    for (const e of candidates) {
        const ei = e.extra_info && typeof e.extra_info === "object" ? e.extra_info : null;
        let id = null;
        if (ei && ei.node_id != null) id = String(ei.node_id);
        // Fall back to parsing "Node ID '#60'" out of details/message
        if (!id) {
            const text = (e.details || "") + " " + (e.message || "");
            // Match "#60", "#82:485", "#15:371:435" -- the colon path forms too
            const m = text.match(/#(\d+(?::\d+)*)/);
            if (m) id = m[1];
        }
        if (!id) continue;
        // Build a message that's actually informative
        let msg = e.message || e.type || "validation error";
        if (ei && ei.node_title) msg = `${ei.node_title}: ${msg}`;
        else if (ei && ei.class_type) msg = `${ei.class_type}: ${msg}`;
        results.push({ id, msg });
    }
    return results;
}

function hookErrorSources() {
    // 1) Execution errors (runtime failures during queued prompt)
    try {
        api.addEventListener("execution_error", (ev) => {
            const d = ev && ev.detail;
            if (!d) return;
            const nid = d.node_id ?? d.nodeId ?? d.node;
            const msg = d.exception_message || d.message || d.exception_type || "execution error";
            rememberError(nid, msg, "execution");
        });
    } catch (e) {
        console.warn("[JumpToNode] could not attach execution_error listener:", e);
    }

    // 2) Validation errors returned from /prompt - wrap api.queuePrompt
    try {
        if (api && typeof api.queuePrompt === "function") {
            const orig = api.queuePrompt.bind(api);
            api.queuePrompt = async function (number, prompt) {
                const res = await orig(number, prompt);
                try {
                    if (res && typeof res === "object") {
                        if (res.node_errors) {
                            for (const hit of extractAllNodeErrors(res.node_errors)) {
                                rememberError(hit.id, hit.msg, "validation");
                            }
                        }
                        // Flat / single-error shapes (missing_node_type and similar)
                        for (const hit of extractFlatError(res)) {
                            rememberError(hit.id, hit.msg, "validation");
                        }
                    }
                } catch (e) { /* ignore */ }
                return res;
            };
        }
    } catch (e) {
        console.warn("[JumpToNode] could not wrap api.queuePrompt:", e);
    }

    // 3) Fallback: patch window.fetch so we catch /prompt validation failures
    //    even on builds that report them through a raw fetch. Note we check
    //    on EVERY response, not just non-OK -- some Comfy builds return HTTP
    //    200 with a flat error body for missing-node-type cases.
    try {
        const origFetch = window.fetch.bind(window);
        window.fetch = async function (...args) {
            const res = await origFetch(...args);
            try {
                const url = typeof args[0] === "string" ? args[0] : (args[0]?.url || "");
                if (url.endsWith("/prompt")) {
                    const clone = res.clone();
                    const data = await clone.json().catch(() => null);
                    if (data && typeof data === "object") {
                        if (data.node_errors) {
                            for (const hit of extractAllNodeErrors(data.node_errors)) {
                                rememberError(hit.id, hit.msg, "validation");
                            }
                        }
                        for (const hit of extractFlatError(data)) {
                            rememberError(hit.id, hit.msg, "validation");
                        }
                    }
                }
            } catch (e) { /* non-fatal */ }
            return res;
        };
    } catch (e) {
        console.warn("[JumpToNode] could not wrap window.fetch:", e);
    }
}

// --------------------------------------------------------------------------
// Parsing and graph traversal
// --------------------------------------------------------------------------
function parseTarget(raw) {
    if (raw == null) return null;
    const cleaned = String(raw).trim().replace(/^#/, "");
    if (!cleaned) return null;
    const parts = cleaned.split(":").map(s => s.trim()).filter(Boolean);
    if (!parts.length) return null;
    const ids = [];
    for (const p of parts) {
        const n = Number(p);
        if (!Number.isInteger(n)) return null;
        ids.push(n);
    }
    return ids;
}

function findNodeInGraph(graph, id) {
    if (!graph) return null;
    if (typeof graph.getNodeById === "function") {
        const n = graph.getNodeById(id);
        if (n) return n;
    }
    const nodes = graph._nodes || graph.nodes || [];
    for (const n of nodes) {
        if (n && n.id === id) return n;
    }
    return null;
}

function enterSubgraph(node) {
    if (!node) return null;
    const canvas = app.canvas;
    const childGraph = node.subgraph || (node.properties && node.properties.subgraph) || null;

    if (canvas && typeof canvas.openSubgraph === "function" && childGraph) {
        canvas.openSubgraph(childGraph);
        return childGraph;
    }
    if (canvas && typeof canvas.setGraph === "function" && childGraph) {
        canvas.setGraph(childGraph);
        return childGraph;
    }
    if (typeof node.onDblClick === "function") {
        try {
            node.onDblClick({}, [0, 0], canvas);
            return app.canvas.graph;
        } catch (e) { /* ignore */ }
    }
    return null;
}

function focusNode(node) {
    if (!node) return;
    const canvas = app.canvas;
    if (!canvas) return;

    const w = (node.size && node.size[0]) || 200;
    const h = (node.size && node.size[1]) || 100;
    const cx = node.pos[0] + w / 2;
    const cy = node.pos[1] + h / 2;

    const ds = canvas.ds;
    if (ds && ds.offset && canvas.canvas) {
        if (ds.scale < 0.2 || ds.scale > 2) ds.scale = 1.0;
        const viewW = canvas.canvas.width / (window.devicePixelRatio || 1);
        const viewH = canvas.canvas.height / (window.devicePixelRatio || 1);
        ds.offset[0] = (viewW / 2) / ds.scale - cx;
        ds.offset[1] = (viewH / 2) / ds.scale - cy;
    }

    if (typeof canvas.selectNode === "function") {
        canvas.selectNode(node, false);
    } else if (canvas.selected_nodes) {
        canvas.selected_nodes = {};
        canvas.selected_nodes[node.id] = node;
    }

    canvas.setDirty(true, true);

    const origBg = node.bgcolor;
    const origCol = node.color;
    node.bgcolor = "#ffcc00";
    node.color = "#ffaa00";
    canvas.setDirty(true, true);
    setTimeout(() => {
        node.bgcolor = origBg;
        node.color = origCol;
        canvas.setDirty(true, true);
    }, 700);
}

function jumpToPath(path, statusFn) {
    if (!path || !path.length) return false;

    const rootGraph = app.graph;
    let currentGraph = rootGraph;
    const canvas = app.canvas;

    if (canvas && typeof canvas.closeSubgraph === "function") {
        let guard = 10;
        while (canvas.graph && canvas.graph !== rootGraph && guard-- > 0) {
            try { canvas.closeSubgraph(); } catch (e) { break; }
        }
        currentGraph = canvas.graph || rootGraph;
    } else if (canvas && typeof canvas.setGraph === "function") {
        canvas.setGraph(rootGraph);
        currentGraph = rootGraph;
    }

    for (let i = 0; i < path.length; i++) {
        const id = path[i];
        const node = findNodeInGraph(currentGraph, id);
        if (!node) {
            const msg = `Could not find node ${id} (step ${i + 1} of path ${path.join(":")})`;
            console.warn(`[JumpToNode] ${msg}`);
            if (statusFn) statusFn(msg, true);
            return false;
        }
        if (i === path.length - 1) {
            focusNode(node);
            if (statusFn) statusFn(`Jumped to node ${path.join(":")}`, false);
            return true;
        }
        const child = enterSubgraph(node);
        if (!child) {
            const msg = `Node ${id} is not a subgraph or could not be entered`;
            console.warn(`[JumpToNode] ${msg}`);
            if (statusFn) statusFn(msg, true);
            return false;
        }
        currentGraph = child;
    }
    return true;
}

// --------------------------------------------------------------------------
// Cycling through the error history + a toast for feedback outside the dialog
// --------------------------------------------------------------------------
let toastEl = null;
let toastTimer = null;

function showToast(html, isError) {
    if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.style.cssText = `
            position: fixed; bottom: 32px; left: 50%;
            transform: translateX(-50%); z-index: 10001;
            background: #1e1e1e; color: #e6e6e6;
            border: 1px solid #3a3a3a; border-radius: 8px;
            box-shadow: 0 8px 28px rgba(0,0,0,0.55);
            padding: 14px 20px; font-size: 14px; line-height: 1.5;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            max-width: 720px; pointer-events: auto; cursor: pointer;
            opacity: 0; transition: opacity 0.15s ease-out;
        `;
        // Click toast to dismiss early
        toastEl.addEventListener("click", () => {
            toastEl.style.opacity = "0";
            if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
        });
        document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = html;
    toastEl.style.borderColor = isError ? "#8a4242" : "#3a3a3a";
    toastEl.style.opacity = "1";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = "0"; }, settings.toastDurationMs);
}

function cycleToCursor() {
    const entry = errorHistory[cursor];
    if (!entry) return;
    const path = parseTarget(entry.nodeId);
    if (!path) {
        showToast(`Stored error id '${entry.nodeId}' is unparseable`, true);
        return;
    }
    const idxLabel = `[${cursor + 1}/${errorHistory.length}]`;
    const msgShort = entry.message
        ? (entry.message.length > 80 ? entry.message.slice(0, 80) + "..." : entry.message)
        : "";
    const ok = jumpToPath(path);
    if (ok) {
        showToast(
            `<b>${idxLabel}</b> node <code style="color:#ffd27a">${escapeHtml(entry.nodeId)}</code><br>` +
            `<span style="color:#9a9a9a">${escapeHtml(msgShort)}</span>`,
            false
        );
        // If dialog is open, keep it in sync
        if (dialogEl && dialogEl.style.display !== "none") syncDialogFromCursor();
    } else {
        showToast(`${idxLabel} node ${escapeHtml(entry.nodeId)}: not found in current graph`, true);
    }
}

function cycleNext() {
    const a = activeList();
    if (!a.list.length) {
        showToast(
            a.kind === "search"
                ? "No search results. Type a query in the Jump sidebar."
                : "No error history yet. Queue a prompt that fails first.",
            true
        );
        return;
    }
    if (a.cursor < a.list.length - 1) setActiveCursor(a.cursor + 1);
    cycleToActiveCursor();
}

function cyclePrev() {
    const a = activeList();
    if (!a.list.length) {
        showToast(
            a.kind === "search"
                ? "No search results. Type a query in the Jump sidebar."
                : "No error history yet. Queue a prompt that fails first.",
            true
        );
        return;
    }
    if (a.cursor > 0) setActiveCursor(a.cursor - 1);
    else if (a.cursor < 0) setActiveCursor(a.list.length - 1);
    cycleToActiveCursor();
}

function jumpToLatestError() {
    if (!errorHistory.length) {
        showToast("No error history yet. Queue a prompt that fails first.", true);
        return;
    }
    cursor = errorHistory.length - 1;
    cycleToCursor();
}

// --------------------------------------------------------------------------
// Search engine (by name or by widget)
// --------------------------------------------------------------------------
// Two modes:
//   "name"   -- match against node.title || node.type, plus group titles,
//               note text, and subgraph definition names. Returns each as a
//               jumpable item.
//   "widget" -- match against widget.name across every node in the graph.
//               Returns one entry per matching widget so the user can see
//               every (node, widget, current-value) triple at once. Useful
//               when many copies of the same node need their `steps` etc.
//               kept in sync but you don't have a Set/Get rig in place.
//
// Search results are stored in module-level `searchResults` and the cycle
// hotkeys (Alt+[ / Alt+]) operate on them when present, falling back to
// errorHistory when search is empty. The "Latest error" hotkey always
// targets errorHistory.

let searchResults = [];        // array of search-result entries (see schema below)
let searchCursor = -1;
let searchMode = "name";       // "name" | "widget"
let searchQuery = "";

// Schema:
//   { id: "82:485" or "82",     // path string suitable for jumpToPath
//     label: "KSampler #485",   // first line in result row
//     sub:   "steps = 20",      // optional second line
//     widgetName: "steps",      // present only for widget-mode
//     widgetValue: 20 }         // present only for widget-mode

const SEARCH_DEBOUNCE_MS = 120;
const SEARCH_MAX_RESULTS = 200;

// Walk the live graph + every nested subgraph definition once, yielding
// { node, idPath, scopeLabel } tuples. idPath is the ":"-joined path that
// jumpToPath() expects.
function* walkAllNodes() {
    const seen = new WeakSet();
    function* walkGraph(graph, prefix, scopeLabel) {
        if (!graph || seen.has(graph)) return;
        seen.add(graph);
        const nodes = graph._nodes || graph.nodes || [];
        for (const node of nodes) {
            if (!node || node.id == null) continue;
            const idPath = prefix ? `${prefix}:${node.id}` : String(node.id);
            yield { node, idPath, scopeLabel };
            // Recurse into subgraph instances. The new subgraph system
            // exposes node.subgraph (a graph object) on instance nodes.
            const sub = node.subgraph;
            if (sub && typeof sub === "object") {
                const subLabel = node.title || node.type || "subgraph";
                yield* walkGraph(sub, idPath, scopeLabel ? `${scopeLabel} / ${subLabel}` : subLabel);
            }
        }
    }
    if (app && app.graph) yield* walkGraph(app.graph, "", "");
}

function nodeDisplayLabel(node) {
    const t = (node.title && node.title.trim()) || node.type || "(node)";
    return `${t}  #${node.id}`;
}

// Walk groups in the root graph and every nested subgraph. Groups aren't
// nodes -- they live in graph._groups and have no ID -- so each result
// carries the subgraph-instance path needed to reach its scope (prefixIds,
// an array of node IDs to descend through) plus the group's title and a
// bounds snapshot.
function* walkAllGroups() {
    const seen = new WeakSet();
    function* walkGraph(graph, prefixIds, scopeLabel) {
        if (!graph || seen.has(graph)) return;
        seen.add(graph);
        const groups = graph._groups || graph.groups || [];
        for (const g of groups) {
            if (!g) continue;
            yield { group: g, prefixIds, scopeLabel };
        }
        const nodes = graph._nodes || graph.nodes || [];
        for (const node of nodes) {
            if (!node || node.id == null) continue;
            const sub = node.subgraph;
            if (sub && typeof sub === "object") {
                const subLabel = node.title || node.type || "subgraph";
                yield* walkGraph(
                    sub,
                    [...prefixIds, node.id],
                    scopeLabel ? `${scopeLabel} / ${subLabel}` : subLabel
                );
            }
        }
    }
    if (app && app.graph) yield* walkGraph(app.graph, [], "");
}

function groupBounds(g) {
    // litegraph stores group geometry in _bounding [x, y, w, h]; pos/size
    // accessors exist on newer builds. Read whichever is available.
    if (g._bounding && g._bounding.length >= 4) {
        return [g._bounding[0], g._bounding[1], g._bounding[2], g._bounding[3]];
    }
    if (g.pos && g.size) return [g.pos[0], g.pos[1], g.size[0], g.size[1]];
    return null;
}

// Center the canvas on a rect and zoom out enough to fit it (with margin),
// clamped to a sane range so a tiny group doesn't blow up to 4x zoom.
function focusRect(b) {
    const canvas = app.canvas;
    if (!canvas || !canvas.canvas) return;
    const ds = canvas.ds;
    if (!ds || !ds.offset) return;
    const [x, y, w, h] = b;
    const viewW = canvas.canvas.width / (window.devicePixelRatio || 1);
    const viewH = canvas.canvas.height / (window.devicePixelRatio || 1);
    const fit = Math.min(viewW / (Math.max(w, 1) * 1.3), viewH / (Math.max(h, 1) * 1.3));
    ds.scale = Math.max(0.1, Math.min(fit, 1.0));
    ds.offset[0] = (viewW / 2) / ds.scale - (x + w / 2);
    ds.offset[1] = (viewH / 2) / ds.scale - (y + h / 2);
    canvas.setDirty(true, true);
}

// Navigate to a group: return to root, descend the subgraph-instance path,
// then center+fit on the group's bounds. Re-finds the live group by title in
// the destination scope so the flash and bounds reflect current state; falls
// back to the bounds snapshot taken at search time if the title has changed.
function jumpToGroup(ref) {
    const rootGraph = app.graph;
    const canvas = app.canvas;
    if (!canvas || !rootGraph) return false;

    if (typeof canvas.closeSubgraph === "function") {
        let guard = 10;
        while (canvas.graph && canvas.graph !== rootGraph && guard-- > 0) {
            try { canvas.closeSubgraph(); } catch (e) { break; }
        }
    } else if (typeof canvas.setGraph === "function") {
        canvas.setGraph(rootGraph);
    }
    let currentGraph = canvas.graph || rootGraph;

    for (const id of ref.prefixIds) {
        const node = findNodeInGraph(currentGraph, id);
        if (!node) {
            console.warn(`[JumpToNode] group jump: node ${id} not found on path`);
            return false;
        }
        const child = enterSubgraph(node);
        if (!child) {
            console.warn(`[JumpToNode] group jump: node ${id} could not be entered`);
            return false;
        }
        currentGraph = child;
    }

    let bounds = ref.bounds;
    let liveGroup = null;
    const groups = currentGraph._groups || currentGraph.groups || [];
    for (const g of groups) {
        if (g && String(g.title || "") === ref.title) { liveGroup = g; break; }
    }
    if (liveGroup) bounds = groupBounds(liveGroup) || bounds;
    if (!bounds) return false;

    focusRect(bounds);

    if (liveGroup) {
        const origColor = liveGroup.color;
        liveGroup.color = "#ffcc00";
        canvas.setDirty(true, true);
        setTimeout(() => {
            liveGroup.color = origColor;
            canvas.setDirty(true, true);
        }, 700);
    }
    return true;
}

function searchByName(q) {
    const needle = q.toLowerCase();
    const results = [];
    // Group title matches first -- they're rarer and usually what you're
    // hunting when a title search comes up empty in the node list.
    for (const { group, prefixIds, scopeLabel } of walkAllGroups()) {
        if (results.length >= SEARCH_MAX_RESULTS) break;
        const title = group.title != null ? String(group.title) : "";
        if (!title || !title.toLowerCase().includes(needle)) continue;
        results.push({
            kind: "group",
            id: null,
            label: `Group: ${title}`,
            sub: scopeLabel ? `in ${scopeLabel}` : "(top level)",
            groupRef: {
                prefixIds: prefixIds.slice(),
                title: title,
                bounds: groupBounds(group),
            },
        });
    }
    for (const { node, idPath, scopeLabel } of walkAllNodes()) {
        if (results.length >= SEARCH_MAX_RESULTS) break;
        // Match node title/type and any inline note-like text properties
        const haystacks = [];
        if (node.title) haystacks.push(node.title);
        if (node.type) haystacks.push(node.type);
        // Note nodes commonly store text in widgets[0].value or properties.text
        if (node.properties && typeof node.properties.text === "string") {
            haystacks.push(node.properties.text);
        }
        if (Array.isArray(node.widgets) && node.widgets[0] &&
            (node.type === "Note" || node.type === "MarkdownNote") &&
            typeof node.widgets[0].value === "string") {
            haystacks.push(node.widgets[0].value);
        }
        const hit = haystacks.find(h => h && h.toLowerCase().includes(needle));
        if (!hit) continue;
        results.push({
            id: idPath,
            label: nodeDisplayLabel(node),
            sub: scopeLabel ? `in ${scopeLabel}` : "",
        });
    }
    return results;
}

function searchByWidget(q) {
    const needle = q.toLowerCase();
    const results = [];
    for (const { node, idPath, scopeLabel } of walkAllNodes()) {
        if (results.length >= SEARCH_MAX_RESULTS) break;
        if (!Array.isArray(node.widgets)) continue;
        for (const w of node.widgets) {
            if (!w || !w.name) continue;
            if (!w.name.toLowerCase().includes(needle)) continue;
            // Render the value as text. Truncate strings.
            let valStr;
            if (w.value === null || w.value === undefined) valStr = "(unset)";
            else if (typeof w.value === "string") {
                valStr = w.value.length > 50 ? w.value.slice(0, 47) + "..." : w.value;
            } else {
                valStr = String(w.value);
            }
            results.push({
                id: idPath,
                label: nodeDisplayLabel(node),
                sub: `${w.name} = ${valStr}` + (scopeLabel ? `  ·  in ${scopeLabel}` : ""),
                widgetName: w.name,
                widgetValue: w.value,
            });
            if (results.length >= SEARCH_MAX_RESULTS) break;
        }
    }
    return results;
}

function runSearch(query, mode) {
    searchQuery = query || "";
    searchMode = mode === "widget" ? "widget" : "name";
    if (!searchQuery.trim()) {
        searchResults = [];
        searchCursor = -1;
    } else {
        searchResults = searchMode === "widget"
            ? searchByWidget(searchQuery.trim())
            : searchByName(searchQuery.trim());
        searchCursor = searchResults.length ? 0 : -1;
    }
    return searchResults;
}

// Active list resolution: cycle hotkeys hit search results when present,
// otherwise fall back to error history.
function activeList() {
    if (searchResults.length) {
        return { kind: "search", list: searchResults, cursor: searchCursor };
    }
    return { kind: "error", list: errorHistory, cursor: cursor };
}

function setActiveCursor(newCursor) {
    if (searchResults.length) searchCursor = newCursor;
    else cursor = newCursor;
}

function cycleToActiveCursor() {
    const a = activeList();
    const entry = a.list[a.cursor];
    if (!entry) return;
    const idxLabel = `[${a.cursor + 1}/${a.list.length}]`;

    // Group search results jump via scope navigation + bounds fit, not a
    // node-ID path.
    if (entry.kind === "group" && entry.groupRef) {
        const ok = jumpToGroup(entry.groupRef);
        if (ok) {
            showToast(
                `<b>${idxLabel}</b> ${escapeHtml(entry.label)}` +
                (entry.sub ? `<br><span style="color:#9a9a9a">${escapeHtml(entry.sub)}</span>` : ""),
                false
            );
        } else {
            showToast(`${idxLabel} ${escapeHtml(entry.label)}: could not navigate to group`, true);
        }
        if (sidebarRefresh) { try { sidebarRefresh(); } catch (_) {} }
        return;
    }

    const idStr = entry.id != null ? entry.id : entry.nodeId;
    const path = parseTarget(idStr);
    if (!path) {
        showToast(`Entry id '${idStr}' is unparseable`, true);
        return;
    }
    const ok = jumpToPath(path);
    if (a.kind === "search") {
        if (ok) {
            const labelHtml = escapeHtml(entry.label || idStr);
            const subHtml = entry.sub ? escapeHtml(entry.sub) : "";
            showToast(
                `<b>${idxLabel}</b> ${labelHtml}` +
                (subHtml ? `<br><span style="color:#9a9a9a">${subHtml}</span>` : ""),
                false
            );
        } else {
            showToast(`${idxLabel} ${escapeHtml(idStr)}: not found in current graph`, true);
        }
        if (sidebarRefresh) { try { sidebarRefresh(); } catch (_) {} }
    } else {
        // Existing error-cycle behavior (preserve old toast format)
        const msgShort = entry.message
            ? (entry.message.length > 80 ? entry.message.slice(0, 80) + "..." : entry.message)
            : "";
        if (ok) {
            showToast(
                `<b>${idxLabel}</b> node <code style="color:#ffd27a">${escapeHtml(idStr)}</code>` +
                (msgShort ? `<br><span style="color:#9a9a9a">${escapeHtml(msgShort)}</span>` : ""),
                false
            );
            if (dialogEl && dialogEl.style.display !== "none") syncDialogFromCursor();
        } else {
            showToast(`${idxLabel} node ${escapeHtml(idStr)}: not found in current graph`, true);
        }
    }
}

// --------------------------------------------------------------------------
// Force cache rebuild
// --------------------------------------------------------------------------
// In-editor mirror of the comfyui_force_cache_rebuild.py right-click tool.
// Works around ComfyUI issue #13010 (CacheProvider bug that causes "Required
// input is missing: image" errors on INPUT_IS_LIST nodes inside subgraphs
// after editing a loaded workflow).
//
// Mechanism: iterate every top-level node, find a numeric widget with a
// known-safe name, change its value, then change it back. That double
// value-change event invalidates the frontend's cached reference for the
// node and -- per the upstream issue -- forces the CacheProvider to rebuild
// inputs on the next queue. We use setTimeout between the two changes so
// the frontend processes them as separate events.
//
// "Safe" widgets are ones where a transient bump has no side effect if we
// revert correctly. We avoid seeds (changes RNG state if the node peeks),
// combos/dropdowns (might have dependent-widget side-effects), and strings.
// Prefers steps / cfg / denoise / width / height / strength numeric sliders.
// --------------------------------------------------------------------------

const SAFE_WIDGET_NAMES = [
    "steps", "cfg", "denoise", "strength",
    "width", "height", "batch_size",
    "noise_seed", "frame_rate",
];

function findSafeWidget(node) {
    if (!node || !Array.isArray(node.widgets)) return null;
    for (const name of SAFE_WIDGET_NAMES) {
        const w = node.widgets.find(
            x => x && x.name === name &&
                 (typeof x.value === "number" || typeof x.value === "boolean")
        );
        if (w) return w;
    }
    // Fallback: any numeric widget that isn't named "seed"
    for (const w of node.widgets) {
        if (!w) continue;
        if (w.name === "seed") continue;
        if (typeof w.value === "number") return w;
    }
    return null;
}

function bumpAndRevert(widget) {
    const original = widget.value;
    let bumped;
    if (typeof original === "boolean") {
        bumped = !original;
    } else if (typeof original === "number") {
        // +1 is safest for ints and visible-enough for floats.
        bumped = original + 1;
    } else {
        return false;
    }
    try {
        widget.value = bumped;
        if (typeof widget.callback === "function") widget.callback(bumped);
        // Revert on next tick so the frontend processes the first change
        // as a distinct event before we set it back.
        setTimeout(() => {
            try {
                widget.value = original;
                if (typeof widget.callback === "function") widget.callback(original);
                if (app.graph && typeof app.graph.setDirtyCanvas === "function") {
                    app.graph.setDirtyCanvas(true, true);
                }
            } catch (_) { /* no-op */ }
        }, 0);
        return true;
    } catch (_) {
        return false;
    }
}

function forceCacheRebuild() {
    const graph = app.graph;
    if (!graph || !Array.isArray(graph._nodes)) {
        showToast("Can't access graph. Is a workflow loaded?", true);
        return;
    }
    let touched = 0;
    let scanned = 0;
    for (const node of graph._nodes) {
        scanned += 1;
        const widget = findSafeWidget(node);
        if (!widget) continue;
        if (bumpAndRevert(widget)) touched += 1;
    }
    if (touched === 0) {
        showToast(
            `Scanned ${scanned} top-level node(s) but none had a safe widget ` +
            `to bump. Try queueing immediately after a fresh load, or use the ` +
            `right-click "Force Cache Rebuild" on the workflow file before ` +
            `dragging it in.`,
            true
        );
        return;
    }
    showToast(
        `Cache rebuild: bumped a safe widget on ${touched} of ${scanned} ` +
        `top-level node(s). Queue now before making further edits.`,
        false
    );
    jtnLog(`[JumpToNode] forceCacheRebuild: bumped ${touched}/${scanned} nodes`);
}

function escapeHtml(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// --------------------------------------------------------------------------
// Floating dialog UI
// --------------------------------------------------------------------------
let dialogEl = null;
let inputEl = null;
let statusEl = null;
let errorBtnEl = null;
let prevBtnEl = null;
let nextBtnEl = null;

function syncDialogFromCursor() {
    if (!errorBtnEl) return;
    if (!errorHistory.length) {
        errorBtnEl.textContent = "Last error node (none yet)";
        errorBtnEl.disabled = true;
        errorBtnEl.style.opacity = "0.5";
        if (prevBtnEl) { prevBtnEl.disabled = true; prevBtnEl.style.opacity = "0.4"; }
        if (nextBtnEl) { nextBtnEl.disabled = true; nextBtnEl.style.opacity = "0.4"; }
        return;
    }
    const idx = cursor >= 0 ? cursor : errorHistory.length - 1;
    const entry = errorHistory[idx];
    const counter = `[${idx + 1}/${errorHistory.length}]`;
    const msgShort = entry.message
        ? ` - ${entry.message.slice(0, 32)}${entry.message.length > 32 ? "..." : ""}`
        : "";
    errorBtnEl.textContent = `${counter} ${entry.nodeId}${msgShort}`;
    errorBtnEl.disabled = false;
    errorBtnEl.style.opacity = "1";
    if (prevBtnEl) {
        prevBtnEl.disabled = idx <= 0;
        prevBtnEl.style.opacity = idx <= 0 ? "0.4" : "1";
    }
    if (nextBtnEl) {
        nextBtnEl.disabled = idx >= errorHistory.length - 1;
        nextBtnEl.style.opacity = idx >= errorHistory.length - 1 ? "0.4" : "1";
    }
}

function buttonStyle(bg, fg) {
    return `
        background: ${bg}; color: ${fg}; border: 1px solid #000;
        border-radius: 4px; padding: 6px 12px; cursor: pointer;
        font-size: 12px; font-weight: 500;
    `;
}

function buildDialog() {
    if (dialogEl) return dialogEl;

    const overlay = document.createElement("div");
    overlay.id = "jtn-overlay";
    overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 10000; display: none;
        background: rgba(0,0,0,0.35);
        align-items: flex-start; justify-content: center;
        padding-top: 18vh;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    const panel = document.createElement("div");
    panel.style.cssText = `
        background: #1e1e1e; color: #e6e6e6;
        border: 1px solid #3a3a3a; border-radius: 8px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.6);
        width: min(520px, 92vw); padding: 16px 18px;
    `;

    const title = document.createElement("div");
    title.textContent = "Jump to node";
    title.style.cssText = "font-size: 14px; font-weight: 600; margin-bottom: 10px; letter-spacing: 0.02em;";

    const hint = document.createElement("div");
    hint.textContent = "Enter a node ID (e.g. 110) or subgraph path (e.g. 82:485, 15:371:435). # prefix OK.";
    hint.style.cssText = "font-size: 11px; color: #9a9a9a; margin-bottom: 10px; line-height: 1.4;";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Paste node ID from the Comfy console...";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.style.cssText = `
        width: 100%; box-sizing: border-box;
        background: #121212; color: #fff; border: 1px solid #444;
        border-radius: 4px; padding: 8px 10px; font-size: 14px;
        font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
        outline: none;
    `;
    input.addEventListener("focus", () => { input.style.borderColor = "#6a9cff"; });
    input.addEventListener("blur",  () => { input.style.borderColor = "#444"; });

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display: flex; gap: 6px; margin-top: 10px; align-items: center;";

    const jumpBtn = document.createElement("button");
    jumpBtn.textContent = "Jump (Enter)";
    jumpBtn.style.cssText = buttonStyle("#2d6cdf", "#fff");

    const prevBtn = document.createElement("button");
    prevBtn.textContent = "<";
    prevBtn.title = `Previous error in history (Alt+[)`;
    prevBtn.style.cssText = buttonStyle("#3a2a2a", "#ffc8c8") + " min-width: 28px; padding-left: 8px; padding-right: 8px;";

    const errBtn = document.createElement("button");
    errBtn.textContent = "Last error node";
    errBtn.title = "Jump to the node the backend last complained about";
    errBtn.style.cssText = buttonStyle("#5a3030", "#ffc8c8");

    const nextBtn = document.createElement("button");
    nextBtn.textContent = ">";
    nextBtn.title = `Next error in history (Alt+])`;
    nextBtn.style.cssText = buttonStyle("#3a2a2a", "#ffc8c8") + " min-width: 28px; padding-left: 8px; padding-right: 8px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Close (Esc)";
    cancelBtn.style.cssText = buttonStyle("#2a2a2a", "#ccc");

    const spacer = document.createElement("div");
    spacer.style.cssText = "flex: 1;";

    const status = document.createElement("div");
    status.style.cssText = "margin-top: 10px; font-size: 11px; color: #9a9a9a; min-height: 14px;";

    btnRow.appendChild(jumpBtn);
    btnRow.appendChild(prevBtn);
    btnRow.appendChild(errBtn);
    btnRow.appendChild(nextBtn);
    btnRow.appendChild(spacer);
    btnRow.appendChild(cancelBtn);

    panel.appendChild(title);
    panel.appendChild(hint);
    panel.appendChild(input);
    panel.appendChild(btnRow);
    panel.appendChild(status);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    function setStatus(msg, isError) {
        status.textContent = msg || "";
        status.style.color = isError ? "#ff8080" : "#9acb8a";
    }

    function doJump() {
        const path = parseTarget(input.value);
        if (!path) {
            setStatus("Could not parse. Use a number or colon-separated IDs like 82:485.", true);
            return;
        }
        const ok = jumpToPath(path, setStatus);
        if (ok) setTimeout(close, 250);
    }

    function doErrorJump() {
        // Jump to whatever the cursor currently points to; if the history is
        // non-empty but cursor is dangling, snap to newest.
        if (!errorHistory.length) {
            setStatus("No backend error seen yet. Queue a prompt first.", true);
            return;
        }
        if (cursor < 0 || cursor >= errorHistory.length) {
            cursor = errorHistory.length - 1;
        }
        const entry = errorHistory[cursor];
        const path = parseTarget(entry.nodeId);
        if (!path) {
            setStatus(`Stored error id '${entry.nodeId}' is unparseable`, true);
            return;
        }
        const ok = jumpToPath(path, setStatus);
        if (ok) {
            syncDialogFromCursor();
            setTimeout(close, 250);
        }
    }

    function doPrev() {
        if (!errorHistory.length) {
            setStatus("No error history yet.", true);
            return;
        }
        if (cursor > 0) cursor -= 1;
        else if (cursor < 0) cursor = errorHistory.length - 1;
        const entry = errorHistory[cursor];
        const path = parseTarget(entry.nodeId);
        if (path) jumpToPath(path, setStatus);
        syncDialogFromCursor();
    }

    function doNext() {
        if (!errorHistory.length) {
            setStatus("No error history yet.", true);
            return;
        }
        if (cursor < errorHistory.length - 1) cursor += 1;
        const entry = errorHistory[cursor];
        const path = parseTarget(entry.nodeId);
        if (path) jumpToPath(path, setStatus);
        syncDialogFromCursor();
    }

    jumpBtn.addEventListener("click", doJump);
    errBtn.addEventListener("click", doErrorJump);
    prevBtn.addEventListener("click", doPrev);
    nextBtn.addEventListener("click", doNext);
    cancelBtn.addEventListener("click", close);

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); doJump(); }
        else if (e.key === "Escape") { e.preventDefault(); close(); }
    });

    overlay.addEventListener("mousedown", (e) => {
        if (e.target === overlay) close();
    });

    dialogEl = overlay;
    inputEl = input;
    statusEl = status;
    errorBtnEl = errBtn;
    prevBtnEl = prevBtn;
    nextBtnEl = nextBtn;
    return overlay;
}

function open() {
    buildDialog();
    dialogEl.style.display = "flex";
    syncDialogFromCursor();
    if (statusEl) statusEl.textContent = "";
    if (inputEl) {
        // Pre-fill with the cursor's node ID so Enter immediately jumps there.
        const entry = errorHistory[cursor >= 0 ? cursor : errorHistory.length - 1];
        inputEl.value = entry ? entry.nodeId : "";
        setTimeout(() => { inputEl.focus(); inputEl.select(); }, 0);
    }
}

function close() {
    if (dialogEl) dialogEl.style.display = "none";
}

function toggle() {
    if (!dialogEl || dialogEl.style.display === "none") open();
    else close();
}

// --------------------------------------------------------------------------
// Registration
// --------------------------------------------------------------------------
app.registerExtension({
    name: EXT_NAME,

    commands: [
        {
            id: "JumpToNode.open",
            label: "Jump to node by ID",
            function: () => open(),
        },
        {
            id: "JumpToNode.lastError",
            label: "Jump to last erroring node",
            function: () => jumpToLatestError(),
        },
        {
            id: "JumpToNode.nextError",
            label: "Jump to next error node in history",
            function: () => cycleNext(),
        },
        {
            id: "JumpToNode.prevError",
            label: "Jump to previous error node in history",
            function: () => cyclePrev(),
        },
        {
            id: "JumpToNode.forceCacheRebuild",
            label: "Force ComfyUI cache rebuild (issue #13010 workaround)",
            function: () => forceCacheRebuild(),
        },
        {
            id: "JumpToNode.clearSearch",
            label: "Clear search results (re-enable error cycling)",
            function: () => {
                searchResults = [];
                searchCursor = -1;
                searchQuery = "";
                if (sidebarRefresh) { try { sidebarRefresh(); } catch (_) {} }
                showToast("Search cleared. Alt+[ / Alt+] now cycle error history.", false);
            },
        },
    ],

    // No `keybindings[]` block - registering Ctrl+Alt+J through Comfy's binding
    // system would error at launch if any other pack claims the same chord.
    // The window-level keydown listener below handles the hotkey and runs in
    // the capture phase so it's immune to cross-extension collisions.

    async setup() {
        hookErrorSources();

        // --------------------------------------------------------------
        // Sidebar tab
        // --------------------------------------------------------------
        // A single icon in the left sidebar (magnifying glass). Clicking
        // it opens the Jump dialog directly -- same effect as Ctrl+Alt+J,
        // just one mouse click. The tab body itself shows a compact panel
        // with shortcut reminders so the sidebar isn't empty when the
        // dialog is dismissed.
        //
        // Wrapped in try/catch because older Comfy frontends don't expose
        // extensionManager.registerSidebarTab -- in that case we silently
        // skip, keeping the hotkeys / command palette / right-click menu
        // as the usable interface.
        try {
            if (app.extensionManager &&
                typeof app.extensionManager.registerSidebarTab === "function") {
                app.extensionManager.registerSidebarTab({
                    id: "jump-to-node",
                    icon: "pi pi-search",
                    title: "Jump",
                    tooltip: "Jump to node by ID / error (Ctrl+Alt+J)",
                    type: "custom",
                    render: (el) => {
                        el.innerHTML = "";
                        const wrap = document.createElement("div");
                        wrap.style.cssText =
                            "padding:12px;color:#ddd;font:13px sans-serif;" +
                            "display:flex;flex-direction:column;gap:10px;";

                        const title = document.createElement("div");
                        title.textContent = "Jump to node";
                        title.style.cssText =
                            "font-size:15px;font-weight:600;color:#fff;";
                        wrap.appendChild(title);

                        // -------- Inline Jump-by-ID input ----------------
                        // Lets you do the most common task (jump to a node by
                        // ID or path) without opening the floating dialog.
                        const jumpRow = document.createElement("div");
                        jumpRow.style.cssText =
                            "display:flex;gap:6px;align-items:stretch;";

                        const idInput = document.createElement("input");
                        idInput.type = "text";
                        idInput.placeholder = "Node ID or path  (e.g. 110, 82:485)";
                        idInput.spellcheck = false;
                        idInput.autocomplete = "off";
                        idInput.style.cssText =
                            "flex:1;padding:7px 9px;border-radius:4px;" +
                            "border:1px solid #444;background:#181818;" +
                            "color:#eee;font:13px monospace;outline:none;";
                        // Pre-fill with most recent error id when one exists.
                        const _latest = errorHistory[errorHistory.length - 1];
                        if (_latest) idInput.value = _latest.nodeId;

                        const goBtn = document.createElement("button");
                        goBtn.textContent = "Go";
                        goBtn.style.cssText = buttonStyle("#2d5fbf", "#fff") +
                            "padding:7px 14px;";

                        function doInlineJump() {
                            const path = parseTarget(idInput.value);
                            if (!path) {
                                showToast("Could not parse. Use a number or colon-separated IDs like 82:485.", true);
                                return;
                            }
                            jumpToPath(path);
                        }
                        idInput.addEventListener("keydown", (e) => {
                            if (e.key === "Enter") { e.preventDefault(); doInlineJump(); }
                        });
                        goBtn.addEventListener("click", doInlineJump);

                        jumpRow.appendChild(idInput);
                        jumpRow.appendChild(goBtn);
                        wrap.appendChild(jumpRow);
                        // -------- end inline Jump-by-ID ------------------

                        const mkBtn = (label, fn, bg) => {
                            const b = document.createElement("button");
                            b.textContent = label;
                            b.style.cssText = buttonStyle(bg || "#2d5fbf", "#fff") +
                                "text-align:left;padding:8px 12px;";
                            b.addEventListener("click", fn);
                            return b;
                        };

                        wrap.appendChild(mkBtn("Open dialog  (Ctrl+Alt+J)",
                                               () => open()));
                        wrap.appendChild(mkBtn("Go to last error  (Ctrl+Alt+E)",
                                               () => jumpToLatestError()));

                        const cycleRow = document.createElement("div");
                        cycleRow.style.cssText = "display:flex;gap:6px;";
                        const prev = mkBtn("< Prev (Alt+[)", () => cyclePrev());
                        const next = mkBtn("Next > (Alt+])", () => cycleNext());
                        prev.style.flex = next.style.flex = "1";
                        cycleRow.appendChild(prev);
                        cycleRow.appendChild(next);
                        wrap.appendChild(cycleRow);

                        // ---- Search section ----------------------------
                        const searchWrap = document.createElement("div");
                        searchWrap.style.cssText =
                            "display:flex;flex-direction:column;gap:6px;" +
                            "border-top:1px solid #333;padding-top:10px;" +
                            "margin-top:2px;";

                        const searchHeader = document.createElement("div");
                        searchHeader.textContent = "Search";
                        searchHeader.style.cssText =
                            "font-size:12px;font-weight:600;color:#bbb;" +
                            "text-transform:uppercase;letter-spacing:0.05em;";
                        searchWrap.appendChild(searchHeader);

                        // Mode toggle: Name / Widget
                        const modeRow = document.createElement("div");
                        modeRow.style.cssText = "display:flex;gap:4px;";
                        const mkModeBtn = (label, mode) => {
                            const b = document.createElement("button");
                            b.textContent = label;
                            b.dataset.mode = mode;
                            b.style.cssText =
                                "flex:1;padding:6px 8px;border-radius:4px;" +
                                "border:1px solid #333;font:12px sans-serif;" +
                                "cursor:pointer;background:#222;color:#bbb;";
                            return b;
                        };
                        const nameModeBtn = mkModeBtn("Name", "name");
                        const widgetModeBtn = mkModeBtn("Widget", "widget");
                        modeRow.appendChild(nameModeBtn);
                        modeRow.appendChild(widgetModeBtn);
                        searchWrap.appendChild(modeRow);

                        function paintModeButtons() {
                            for (const b of [nameModeBtn, widgetModeBtn]) {
                                const active = b.dataset.mode === searchMode;
                                b.style.background = active ? "#2d5fbf" : "#222";
                                b.style.color = active ? "#fff" : "#bbb";
                                b.style.borderColor = active ? "#3d6fcf" : "#333";
                            }
                        }
                        paintModeButtons();

                        const searchInput = document.createElement("input");
                        searchInput.type = "text";
                        searchInput.placeholder =
                            "Type to search... (e.g. KSampler, steps, scheduler)";
                        searchInput.value = searchQuery;
                        searchInput.style.cssText =
                            "padding:7px 9px;border-radius:4px;" +
                            "border:1px solid #444;background:#181818;" +
                            "color:#eee;font:13px sans-serif;outline:none;";
                        searchWrap.appendChild(searchInput);

                        const searchListEl = document.createElement("div");
                        searchListEl.style.cssText =
                            "display:flex;flex-direction:column;gap:4px;" +
                            "max-height:280px;overflow-y:auto;";
                        searchWrap.appendChild(searchListEl);

                        const searchHint = document.createElement("div");
                        searchHint.style.cssText =
                            "font-size:11px;color:#777;line-height:1.4;";
                        searchHint.innerHTML =
                            "<b>Name</b> matches node title/type, group names, " +
                            "and Note text.<br>" +
                            "<b>Widget</b> matches widget names " +
                            "(e.g. <code>steps</code>, <code>seed</code>, " +
                            "<code>scheduler</code>) -- shows current value.<br>" +
                            "<b>Alt+[</b> / <b>Alt+]</b> cycle through results " +
                            "when search is active.";
                        searchWrap.appendChild(searchHint);

                        wrap.appendChild(searchWrap);

                        function refreshSearchList() {
                            searchListEl.innerHTML = "";
                            if (!searchQuery.trim()) {
                                const empty = document.createElement("div");
                                empty.textContent =
                                    "(type above to search the current workflow)";
                                empty.style.cssText =
                                    "color:#666;font-style:italic;font-size:12px;" +
                                    "padding:4px 0;";
                                searchListEl.appendChild(empty);
                                return;
                            }
                            if (!searchResults.length) {
                                const empty = document.createElement("div");
                                empty.textContent =
                                    `No matches for "${searchQuery}" in ` +
                                    (searchMode === "widget" ? "widget names" : "node names");
                                empty.style.cssText =
                                    "color:#888;font-size:12px;padding:4px 0;";
                                searchListEl.appendChild(empty);
                                return;
                            }
                            const summary = document.createElement("div");
                            summary.textContent =
                                `${searchResults.length} match` +
                                (searchResults.length === 1 ? "" : "es") +
                                (searchResults.length >= SEARCH_MAX_RESULTS
                                    ? "  (capped -- refine your query)" : "");
                            summary.style.cssText =
                                "color:#888;font-size:11px;padding:2px 0 4px 0;";
                            searchListEl.appendChild(summary);

                            // Cap visible rows for performance; the full
                            // result set is still cycle-able via Alt+[ / Alt+]
                            const visibleMax = 50;
                            const cap = Math.min(searchResults.length, visibleMax);
                            for (let i = 0; i < cap; i++) {
                                const entry = searchResults[i];
                                const isCurrent = i === searchCursor;
                                const row = document.createElement("button");
                                row.style.cssText =
                                    "display:flex;flex-direction:column;gap:2px;" +
                                    "text-align:left;padding:6px 8px;" +
                                    "background:" + (isCurrent ? "#1d3357" : "#222") + ";" +
                                    "border:1px solid " + (isCurrent ? "#3d6fcf" : "#333") + ";" +
                                    "border-radius:4px;color:#ddd;cursor:pointer;" +
                                    "font:12px sans-serif;";
                                const labelLine = document.createElement("div");
                                labelLine.textContent = entry.label || entry.id;
                                labelLine.style.cssText =
                                    "font-weight:600;color:#fff;";
                                row.appendChild(labelLine);
                                if (entry.sub) {
                                    const subLine = document.createElement("div");
                                    subLine.textContent = entry.sub;
                                    subLine.style.cssText =
                                        "color:#aaa;font-size:11px;line-height:1.3;" +
                                        "font-family:monospace;";
                                    row.appendChild(subLine);
                                }
                                row.addEventListener("click", () => {
                                    searchCursor = i;
                                    cycleToActiveCursor();
                                });
                                searchListEl.appendChild(row);
                            }
                            if (searchResults.length > visibleMax) {
                                const more = document.createElement("div");
                                more.textContent =
                                    `... +${searchResults.length - visibleMax} more ` +
                                    `(use Alt+] to cycle through all)`;
                                more.style.cssText =
                                    "color:#888;font-size:11px;padding:4px 0;font-style:italic;";
                                searchListEl.appendChild(more);
                            }
                        }

                        // Debounced search-as-you-type
                        let searchTimer = null;
                        const triggerSearch = () => {
                            if (searchTimer) clearTimeout(searchTimer);
                            searchTimer = setTimeout(() => {
                                runSearch(searchInput.value, searchMode);
                                refreshSearchList();
                            }, SEARCH_DEBOUNCE_MS);
                        };
                        searchInput.addEventListener("input", triggerSearch);
                        searchInput.addEventListener("keydown", (e) => {
                            // Enter jumps to the first/current result
                            if (e.key === "Enter" && searchResults.length) {
                                e.preventDefault();
                                if (searchCursor < 0) searchCursor = 0;
                                cycleToActiveCursor();
                            }
                            // Escape clears the search
                            if (e.key === "Escape") {
                                searchInput.value = "";
                                runSearch("", searchMode);
                                refreshSearchList();
                            }
                        });

                        nameModeBtn.addEventListener("click", () => {
                            searchMode = "name";
                            paintModeButtons();
                            runSearch(searchInput.value, "name");
                            refreshSearchList();
                        });
                        widgetModeBtn.addEventListener("click", () => {
                            searchMode = "widget";
                            paintModeButtons();
                            runSearch(searchInput.value, "widget");
                            refreshSearchList();
                        });

                        refreshSearchList();
                        // ----- end Search section ---------------------

                        // Recent errors list -- live-updated via sidebarRefresh
                        const recentWrap = document.createElement("div");
                        recentWrap.style.cssText =
                            "display:flex;flex-direction:column;gap:4px;" +
                            "border-top:1px solid #333;padding-top:10px;" +
                            "margin-top:2px;";

                        const recentHeader = document.createElement("div");
                        recentHeader.textContent = "Recent errors";
                        recentHeader.style.cssText =
                            "font-size:12px;font-weight:600;color:#bbb;" +
                            "text-transform:uppercase;letter-spacing:0.05em;";
                        recentWrap.appendChild(recentHeader);

                        const listEl = document.createElement("div");
                        listEl.style.cssText =
                            "display:flex;flex-direction:column;gap:4px;" +
                            "max-height:240px;overflow-y:auto;";
                        recentWrap.appendChild(listEl);
                        wrap.appendChild(recentWrap);

                        function refreshList() {
                            listEl.innerHTML = "";
                            const n = errorHistory.length;
                            if (n === 0) {
                                const empty = document.createElement("div");
                                empty.textContent = "(no errors yet)";
                                empty.style.cssText =
                                    "color:#666;font-style:italic;font-size:12px;" +
                                    "padding:4px 0;";
                                listEl.appendChild(empty);
                                return;
                            }
                            // Last 5, most recent first
                            const start = Math.max(0, n - 5);
                            for (let i = n - 1; i >= start; i--) {
                                const entry = errorHistory[i];
                                const row = document.createElement("button");
                                const isCurrent = i === cursor;
                                row.style.cssText =
                                    "display:flex;flex-direction:column;gap:2px;" +
                                    "text-align:left;padding:6px 8px;" +
                                    "background:" + (isCurrent ? "#3a2a1a" : "#222") + ";" +
                                    "border:1px solid " + (isCurrent ? "#8a4242" : "#333") + ";" +
                                    "border-radius:4px;color:#ddd;cursor:pointer;" +
                                    "font:12px sans-serif;";
                                const idLine = document.createElement("div");
                                idLine.textContent = "#" + entry.nodeId;
                                idLine.style.cssText =
                                    "font-weight:600;color:#fff;font-family:monospace;";
                                row.appendChild(idLine);
                                if (entry.message) {
                                    const msgLine = document.createElement("div");
                                    const msg = String(entry.message);
                                    msgLine.textContent =
                                        msg.length > 60 ? msg.slice(0, 57) + "..." : msg;
                                    msgLine.style.cssText =
                                        "color:#aaa;font-size:11px;line-height:1.3;";
                                    row.appendChild(msgLine);
                                }
                                row.addEventListener("click", () => {
                                    // Searching takes priority over error
                                    // history for the cycle hotkeys, so when
                                    // the user clicks an error row we want
                                    // to make errors the active list. Easiest
                                    // way: clear search state and set the
                                    // error cursor, then go through the
                                    // shared cycle path which knows how to
                                    // parseTarget the string id properly.
                                    searchResults = [];
                                    searchCursor = -1;
                                    cursor = i;
                                    cycleToActiveCursor();
                                });
                                listEl.appendChild(row);
                            }
                        }

                        refreshList();
                        sidebarRefresh = () => {
                            try { refreshList(); } catch (_) {}
                            try { refreshSearchList(); } catch (_) {}
                        };

                        // Force Cache Rebuild -- yellowish button below the list
                        // to visually separate it from the jump actions.
                        const rebuildBtn = mkBtn(
                            "Force cache rebuild",
                            () => forceCacheRebuild(),
                            "#8a6d2a"
                        );
                        rebuildBtn.title =
                            "Bumps a safe widget on every top-level node to " +
                            "force ComfyUI's CacheProvider to rebuild inputs " +
                            "on next queue. Workaround for issue #13010 " +
                            "(\"Required input is missing: image\" after " +
                            "editing). Run this right before queueing.";
                        wrap.appendChild(rebuildBtn);

                        // ---- Settings section --------------------------
                        // Two opt-in toggles, both persisted to localStorage.
                        // Defaults are conservative (both off) so the extension
                        // behaves the same out-of-the-box as before. Users who
                        // want the old behavior tick the auto-open box.
                        const settingsWrap = document.createElement("div");
                        settingsWrap.style.cssText =
                            "display:flex;flex-direction:column;gap:6px;" +
                            "border-top:1px solid #333;padding-top:10px;" +
                            "margin-top:2px;";
                        const settingsHeader = document.createElement("div");
                        settingsHeader.textContent = "Settings";
                        settingsHeader.style.cssText =
                            "font-size:12px;font-weight:600;color:#bbb;" +
                            "text-transform:uppercase;letter-spacing:0.05em;";
                        settingsWrap.appendChild(settingsHeader);

                        function mkToggle(label, key, hint) {
                            const row = document.createElement("label");
                            row.style.cssText =
                                "display:flex;align-items:flex-start;gap:8px;" +
                                "cursor:pointer;padding:4px 0;";
                            const cb = document.createElement("input");
                            cb.type = "checkbox";
                            cb.checked = !!settings[key];
                            cb.style.cssText = "margin-top:2px;";
                            cb.addEventListener("change", () => {
                                settings[key] = cb.checked;
                                saveSettings(settings);
                            });
                            const lbl = document.createElement("div");
                            lbl.style.cssText = "flex:1;font-size:12px;line-height:1.4;";
                            lbl.innerHTML =
                                `<div style="color:#ddd;">${label}</div>` +
                                (hint ? `<div style="color:#888;font-size:11px;margin-top:1px;">${hint}</div>` : "");
                            row.appendChild(cb);
                            row.appendChild(lbl);
                            return row;
                        }

                        settingsWrap.appendChild(mkToggle(
                            "Open floating dialog when sidebar opens",
                            "openDialogFromSidebar",
                            "Restores the original behavior. Off by default since the panel above can do everything the dialog does."
                        ));
                        settingsWrap.appendChild(mkToggle(
                            "Auto-jump to errored node on queue failure",
                            "autoJumpOnError",
                            "When a queue attempt fails validation or execution, jump straight to the first failing node. Yellow flash + toast still show."
                        ));
                        settingsWrap.appendChild(mkToggle(
                            "Log to browser console",
                            "consoleLogging",
                            "Startup banner and error-capture lines in the F12 console. Off by default; they still print at the Verbose/debug level if you need to confirm the extension loaded."
                        ));
                        wrap.appendChild(settingsWrap);
                        // ---- end Settings section ----------------------

                        const hint = document.createElement("div");
                        hint.style.cssText =
                            "font-size:11px;color:#888;line-height:1.5;" +
                            "border-top:1px solid #333;padding-top:8px;" +
                            "margin-top:4px;";
                        hint.innerHTML =
                            "Accepts plain IDs (<code>110</code>), subgraph " +
                            "paths (<code>82:485</code>), and the <code>#</code> " +
                            "prefix from Comfy error messages.<br><br>" +
                            "Errors captured from both <i>/prompt</i> " +
                            "validation and execution-time exceptions. " +
                            "Up to " + HISTORY_MAX + " remembered.";
                        wrap.appendChild(hint);

                        el.appendChild(wrap);

                        // The sidebar tab can optionally auto-open the floating
                        // dialog when clicked. Default is OFF -- the sidebar
                        // panel is fully self-sufficient with the inline Jump
                        // input above. Toggle via the gear at the bottom of
                        // the panel, persisted in localStorage.
                        if (settings.openDialogFromSidebar) {
                            open();
                        }
                    },
                });
            }
        } catch (err) {
            console.warn("[JumpToNode] sidebar tab registration failed:", err);
        }

        // Hotkeys. All registered in the capture phase so they fire before
        // any other extension's listener can claim them.
        window.addEventListener("keydown", (e) => {
            const t = e.target;
            const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
            // Allow hotkeys inside our own dialog's input field, block them in
            // any other text field (so typing "[" in a node prompt doesn't
            // hijack the cycle hotkey).
            if (inField && t !== inputEl) return;

            const ctrl = e.ctrlKey || e.metaKey;
            const alt = e.altKey;
            const shift = e.shiftKey;

            // Ctrl+Alt+J : toggle dialog
            if (ctrl && alt && !shift && (e.key === "j" || e.key === "J" || e.code === "KeyJ")) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                toggle();
                return;
            }

            // Ctrl+Alt+E : jump to most recent error
            if (ctrl && alt && !shift && (e.key === "e" || e.key === "E" || e.code === "KeyE")) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                jumpToLatestError();
                return;
            }

            // Alt+] : next error in history
            // Alt+[ : previous error in history
            if (alt && !ctrl && !shift) {
                if (e.key === "]" || e.code === "BracketRight") {
                    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                    cycleNext();
                    return;
                }
                if (e.key === "[" || e.code === "BracketLeft") {
                    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                    cyclePrev();
                    return;
                }
            }
        }, true);

        // Canvas right-click menu entries -- migrated to the new
        // getCanvasMenuItems API (the old LGraphCanvas.prototype monkey-patch
        // approach is deprecated and prints a warning on every load).
        // Note: registerExtension's getCanvasMenuItems hook is defined at the
        // top-level extension config object below, not here in setup(). This
        // setup() block is intentionally lighter than before -- only the
        // keydown listener remains, since hotkeys aren't migratable to a hook.

        jtnLog(`[JumpToNode] ready (v7.1). Open: ${HOTKEY_DESC} | Latest error: Ctrl+Alt+E | Cycle: Alt+[ / Alt+] | Search: sidebar`);
    },

    // New context-menu API. Returning an array from this hook adds entries
    // to the canvas right-click menu without monkey-patching the prototype.
    getCanvasMenuItems(/* canvas */) {
        return [
            null,
            {
                content: `Jump to node... (${HOTKEY_DESC})`,
                callback: () => open(),
            },
            {
                content: "Jump to latest error node (Ctrl+Alt+E)",
                callback: () => jumpToLatestError(),
            },
            {
                content: "Previous error in history (Alt+[)",
                callback: () => cyclePrev(),
            },
            {
                content: "Next error in history (Alt+])",
                callback: () => cycleNext(),
            },
            null,
            {
                content: "Force ComfyUI cache rebuild",
                callback: () => forceCacheRebuild(),
            },
        ];
    },
});
