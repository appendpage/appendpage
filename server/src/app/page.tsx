/**
 * Landing page (Phase A placeholder).
 *
 * The full UI lives in the appendpage/web repo (Phase C). This is the
 * minimal page the BACKEND serves — enough that hitting the root domain
 * doesn't 404 during development, and that an agent landing here finds
 * the AGENTS.md link.
 */
export default function Page() {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: "4rem auto",
        padding: "0 1.5rem",
        lineHeight: 1.55,
      }}
    >
      <h1 style={{ fontSize: "1.75rem", marginBottom: "0.5rem" }}>append.page</h1>
      <p style={{ color: "#555", marginTop: 0 }}>
        A place to write things that can&apos;t be silently deleted.
      </p>

      <p>
        Anyone can post on any page. No one (including the operator) can edit
        or delete a post. If a post must be removed for legal reasons, the
        removal itself becomes a permanent public record.
      </p>

      <h2 style={{ fontSize: "1.1rem", marginTop: "2rem" }}>For humans</h2>
      <ul>
        <li>
          Browse pages: visit <code>/p/&lt;slug&gt;</code> (full UI ships in
          Phase C).
        </li>
        <li>
          Public dataset:{" "}
          <a href="https://huggingface.co/datasets/appendpage/ledger">
            huggingface.co/datasets/appendpage/ledger
          </a>
        </li>
        <li>
          Source:{" "}
          <a href="https://github.com/appendpage/appendpage">
            github.com/appendpage/appendpage
          </a>
        </li>
      </ul>

      <h2 style={{ fontSize: "1.1rem", marginTop: "1.5rem" }}>For agents</h2>
      <ul>
        <li>
          Wire format + API + how to fork:{" "}
          <a href="/AGENTS.md">/AGENTS.md</a>
        </li>
        <li>
          Machine-readable spec: <a href="/api/spec.json">/api/spec.json</a>
        </li>
        <li>
          Status: <a href="/status">/status</a>
        </li>
      </ul>

      <hr style={{ margin: "3rem 0 1rem", border: "none", borderTop: "1px solid #ddd" }} />
      <footer style={{ color: "#888", fontSize: "0.85em" }}>
        <a href="/AGENTS.md">AGENTS.md</a> ·{" "}
        <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> ·{" "}
        <a href="/contact">Contact</a> · <a href="/status">Status</a>
        <br />
        Run by <a href="https://github.com/da03">@da03</a>. Open source, MIT.
      </footer>
    </main>
  );
}
