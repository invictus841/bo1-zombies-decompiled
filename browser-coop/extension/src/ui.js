// The co-op panel: a small card in the top-right corner of vel.gg. It lives in a shadow root on <html> (the landing
// page swaps out <body>) and keeps its keys and clicks to itself, so the page's "press any key to start" never fires.

const STYLE = `
:host { all: initial; position: fixed; top: 12px; right: 12px; z-index: 2147483647; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #eee; }
.card { width: 280px; background: rgba(8, 8, 8, .92); border: 1px solid #3a3a3a; border-radius: 6px; padding: 12px 14px; box-shadow: 0 6px 24px rgba(0,0,0,.5); }
.head { display: flex; align-items: center; gap: 8px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; font-size: 12px; }
.head .dot { width: 8px; height: 8px; border-radius: 50%; background: #666; flex: none; }
.head .dot.ok { background: #5fbf5f; } .head .dot.wait { background: #e0b84a; } .head .dot.bad { background: #e05a4a; }
.head .grow { flex: 1; }
.head button.icon { all: unset; cursor: pointer; color: #aaa; padding: 0 4px; font-size: 14px; }
.body { margin-top: 10px; display: grid; gap: 8px; }
.muted { color: #aaa; } .error { color: #ff8a7a; } .small { font-size: 12px; }
.code { font: 600 16px/1.2 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: .04em; color: #fff; user-select: all; }
.lines { display: grid; gap: 2px; font-size: 12px; } .lines b { font-weight: 600; color: #ddd; }
button.act { all: unset; box-sizing: border-box; text-align: center; cursor: pointer; padding: 7px 10px; border: 1px solid #555; border-radius: 4px; background: #1d1d1d; color: #fff; font-weight: 600; }
button.act:hover, button.act:focus-visible { background: #2c2c2c; border-color: #888; }
button.act.primary { background: #c9c9c9; color: #000; border-color: #c9c9c9; } button.act.primary:hover { background: #fff; }
button.act[disabled] { opacity: .5; cursor: default; }
.row { display: flex; gap: 6px; } .row > * { flex: 1; }
input { all: unset; box-sizing: border-box; padding: 6px 8px; border: 1px solid #555; border-radius: 4px; background: #111; color: #fff; font: 13px ui-monospace, Menlo, monospace; min-width: 0; }
input:focus { border-color: #999; }
.pill { display: none; }
:host(.compact) .card { display: none; }
:host(.compact) .pill { display: block; pointer-events: none; background: rgba(0,0,0,.55); border-radius: 12px; padding: 3px 10px; font-size: 12px; color: #ddd; }
:host(.compact) .pill:empty { display: none; }
:host(.collapsed) .body { display: none; }
`;

export class Panel {
  constructor(handlers) {
    this.handlers = handlers;
    this.host = document.createElement("bo1z-coop");
    this.root = this.host.attachShadow({ mode: "closed" });
    this.root.innerHTML = `<style>${STYLE}</style><div class="card"><div class="head"><span class="dot"></span><span class="grow">Co-op</span><button class="icon" data-act="collapse" title="Minimise">–</button></div><div class="body"></div></div><div class="pill"></div>`;
    this.card = this.root.querySelector(".card");
    this.body = this.root.querySelector(".body");
    this.dot = this.root.querySelector(".dot");
    this.pill = this.root.querySelector(".pill");
    this.view = null;
    // Keep keyboard and pointer events inside the panel (the page treats any key or click as "start").
    for (const type of ["keydown", "keyup", "keypress", "click", "mousedown", "mouseup", "pointerdown", "pointerup", "wheel"]) {
      this.host.addEventListener(type, (event) => event.stopPropagation());
    }
    this.root.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-act]");
      if (!button || button.disabled) return;
      const act = button.dataset.act;
      if (act === "collapse") { this.host.classList.toggle("collapsed"); return; }
      // A button next to an input sends that input's text.
      const field = button.dataset.field ? this.root.querySelector(`input[data-field="${button.dataset.field}"]`) : null;
      this.handlers[act]?.(field ? field.value : undefined);
    });
    this.root.addEventListener("keydown", (event) => {
      const input = event.target.matches?.("input[data-act]") ? event.target : null;
      if (event.key === "Enter" && input) this.handlers[input.dataset.act]?.(input.value);
    });
  }

  mount() {
    const attach = () => { if (!this.host.isConnected) document.documentElement.append(this.host); };
    if (document.documentElement) attach();
    else document.addEventListener("readystatechange", attach, { once: true });
  }

  /** Re-renders only when the view changes, so typing in the input is never interrupted. */
  render(view) {
    const key = JSON.stringify(view);
    if (key === this.view) return;
    const previous = new Map([...this.root.querySelectorAll("input[data-field]")].map((i) => [i.dataset.field, i.value]));
    this.view = key;
    this.dot.className = `dot ${view.tone ?? ""}`;
    this.host.classList.toggle("compact", Boolean(view.compact));
    this.pill.textContent = view.pill ?? "";
    this.body.replaceChildren(...view.blocks.map((block) => this.block(block)));
    for (const input of this.root.querySelectorAll("input[data-field]")) {
      if (previous.get(input.dataset.field)) input.value = previous.get(input.dataset.field);
    }
  }

  block(block) {
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    switch (block.kind) {
      case "text": return el("div", block.cls ?? "", block.text);
      case "code": return el("div", "code", block.text);
      case "lines": {
        const box = el("div", "lines");
        for (const [label, value] of block.lines) {
          const line = el("div");
          line.append(el("b", "", `${label}: `), document.createTextNode(value));
          box.append(line);
        }
        return box;
      }
      case "buttons": {
        const row = el("div", "row");
        for (const b of block.buttons) {
          const button = el("button", `act ${b.primary ? "primary" : ""}`, b.label);
          button.dataset.act = b.act;
          if (b.disabled) button.disabled = true;
          row.append(button);
        }
        return row;
      }
      case "input": {
        // { field, placeholder, act, label, value }: a text box and its button.
        const row = el("div", "row");
        const input = el("input");
        input.placeholder = block.placeholder ?? "";
        input.spellcheck = false;
        input.dataset.field = block.field;
        input.dataset.act = block.act;
        if (block.value) input.value = block.value;
        const button = el("button", "act", block.label);
        button.dataset.act = block.act;
        button.dataset.field = block.field;
        button.style.flex = "0 0 auto";
        row.append(input, button);
        return row;
      }
      default: return el("div");
    }
  }
}
