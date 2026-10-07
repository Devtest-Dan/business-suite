import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { accessFor, P, type Who } from "@/modules/docs/access";
import { diffStats, hunks, lineDiff, stepsAsText } from "@/modules/docs/diff";
import { extractLinks, Markdown, plainText } from "@/modules/docs/markdown";
import { stepsInput } from "@/modules/docs/schemas";
import { dayIn, dueOn, parseMarkdownFile } from "@/modules/docs/text";

const html = (text: string, resolve?: Parameters<typeof Markdown>[0]["resolve"]) => renderToStaticMarkup(Markdown({ text, resolve }));

describe("docs Markdown renderer", () => {
  it("renders headings, emphasis, lists, quotes, code and tables", () => {
    const out = html(
      [
        "# Title",
        "Some **bold**, *italic*, ~~gone~~ and `code`.",
        "",
        "- one",
        "- two",
        "  - nested",
        "",
        "3. three",
        "4. four",
        "",
        "> quoted",
        "",
        "```",
        "<b>not html</b>",
        "```",
        "",
        "| a | b |",
        "|---|--:|",
        "| 1 | 2 |",
      ].join("\n"),
    );
    expect(out).toContain("<h2");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain("<del>gone</del>");
    expect(out).toContain("<code");
    expect(out).toMatch(/<ul[^>]*><li>one<\/li><li>two<ul[^>]*><li>nested<\/li><\/ul><\/li><\/ul>/);
    expect(out).toContain('<ol start="3"');
    expect(out).toContain("<blockquote");
    expect(out).toContain("&lt;b&gt;not html&lt;/b&gt;");
    expect(out).toContain("<table");
    expect(out).toContain('style="text-align:right"');
  });

  it("never injects HTML and refuses unsafe links and images", () => {
    const out = html('<script>alert(1)</script> [x](javascript:alert(1)) ![i](http://tracker.example/p.gif) [ok](https://example.com) ![f](/api/files/0b7f6d1e-5c4b-4a39-9d2e-3f1a2b3c4d5e)');
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("tracker.example/p.gif\"");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('src="/api/files/0b7f6d1e-5c4b-4a39-9d2e-3f1a2b3c4d5e"');
  });

  it("renders link and emphasis text that itself needs inline parsing, without looping", () => {
    // Regression: the shared sticky regexes were reused by the nested call, so
    // "[Open the message in chat](...)" sent the parser back to the start forever.
    const out = html("Before. [Open the message in chat](http://localhost:3000/m/chat/x?m=y) and **bold _with_ more** after.");
    expect(out).toContain('<a href="http://localhost:3000/m/chat/x?m=y"');
    expect(out).toContain(">Open the message in chat</a>");
    expect(out).toContain("<strong>bold <em>with</em> more</strong>");
    expect(out).toContain("after.");
  }, 5_000);

  it("keeps snake_case words and single line breaks", () => {
    const out = html("use stock_count_sheet\nnext line");
    expect(out).toContain("stock_count_sheet");
    expect(out).toContain("<br/>");
  });

  it("renders [[internal links]], found and missing", () => {
    const out = html("See [[Opening]] and [[Closing|the closing list]] and [[Nope]].", (t) =>
      t === "Nope" ? { href: "/new?title=Nope", exists: false } : { href: `/p/${t.toLowerCase()}`, exists: true },
    );
    expect(out).toContain('href="/p/opening"');
    expect(out).toContain(">the closing list</a>");
    expect(out).toContain('data-wiki="missing"');
  });

  it("finds the links in a page, ignoring code", () => {
    const links = extractLinks("[[A]] and [[B|bee]] `[[C]]` /m/docs/p/0B7F6D1E-5C4B-4A39-9D2E-3F1A2B3C4D5E\n```\n[[D]]\n```");
    expect(links.titles).toEqual(["A", "B"]);
    expect(links.ids).toEqual(["0b7f6d1e-5c4b-4a39-9d2e-3f1a2b3c4d5e"]);
    expect(plainText("## Hi **there** [[Page|link]]")).toBe("Hi there link");
  });
});

describe("docs line diff", () => {
  it("marks added and removed lines and folds unchanged ones", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const after = ["a", "b", "c", "D", "e", "f", "g", "h", "i"].join("\n");
    const ops = lineDiff(before, after);
    expect(diffStats(ops)).toEqual({ added: 2, removed: 1 });
    const h = hunks(ops, 1);
    expect(h[0]).toEqual({ type: "gap", count: 2 });
    expect(h.some((x) => x.type === "ops" && x.ops.some((o) => o.type === "del" && o.text === "d"))).toBe(true);
  });

  it("treats empty text as no lines", () => {
    expect(lineDiff("", "x\ny")).toEqual([
      { type: "add", text: "x" },
      { type: "add", text: "y" },
    ]);
    expect(lineDiff("same", "same").every((o) => o.type === "same")).toBe(true);
  });

  it("writes steps as text with their checks", () => {
    expect(stepsAsText([{ text: "Check fridge", note: "", check: "yesno", checkLabel: "Cold?" }])).toBe("1. Check fridge [check: yes/no: Cold?]");
  });
});

describe("docs Markdown import", () => {
  it("reads front matter, the title heading, steps with checks and notes, and folders", () => {
    const parsed = parseMarkdownFile(
      "Kitchen/Daily/opening.md",
      ["---", "kind: procedure", "schedule: daily", "---", "# Opening checklist", "", "Intro text.", "", "1. Alarm off", "2. Fridge [check: yes/no: Is it cold?]", "   Move stock if not.", "3. Float [check: record Amount]", "", "After."].join("\n"),
    );
    expect(parsed.title).toBe("Opening checklist");
    expect(parsed.kind).toBe("procedure");
    expect(parsed.schedule).toBe("daily");
    expect(parsed.folders).toEqual(["Kitchen", "Daily"]);
    expect(parsed.steps).toEqual([
      { text: "Alarm off", note: "", check: "none", checkLabel: "" },
      { text: "Fridge", note: "Move stock if not.", check: "yesno", checkLabel: "Is it cold?" },
      { text: "Float", note: "", check: "value", checkLabel: "Amount" },
    ]);
    expect(parsed.body).toContain("Intro text.");
    expect(parsed.body).toContain("After.");
    expect(parsed.body).not.toContain("Alarm off");
  });

  it("falls back to the file name, keeps numbered lists in plain pages", () => {
    const parsed = parseMarkdownFile("staff-rota_notes.md", "1. not a step\n2. still text");
    expect(parsed.title).toBe("staff rota notes");
    expect(parsed.kind).toBe("page");
    expect(parsed.steps).toEqual([]);
    expect(parsed.body).toContain("1. not a step");
  });

  it("refuses steps whose check has no question", () => {
    expect(stepsInput.safeParse([{ text: "x", check: "yesno", checkLabel: "" }]).success).toBe(false);
  });
});

describe("docs schedules", () => {
  it("works out today in the business's timezone and what is due", () => {
    const at = new Date("2026-10-07T23:30:00Z"); // a Wednesday in UTC, already Thursday in Auckland
    expect(dayIn("UTC", at)).toBe("2026-10-07");
    expect(dayIn("Pacific/Auckland", at)).toBe("2026-10-08");
    expect(dueOn("daily", null, "2026-10-10")).toBe(true);
    expect(dueOn("weekdays", null, "2026-10-10")).toBe(false); // Saturday
    expect(dueOn("weekdays", null, "2026-10-09")).toBe(true);
    expect(dueOn("weekly", 3, "2026-10-07")).toBe(true);
    expect(dueOn("weekly", 3, "2026-10-08")).toBe(false);
    expect(dueOn("none", null, "2026-10-08")).toBe(false);
  });
});

describe("docs space access", () => {
  const who = (role: "owner" | "admin" | "member" | "guest", perms: string[]): Who => ({ viewer: { id: "u", role }, can: (p) => perms.includes(p) });
  const member = who("member", [P.access, P.edit]);
  const reader = who("member", [P.access]);
  const guest = who("guest", [P.access, P.run]);
  const admin = who("admin", [P.access, P.edit, P.manage]);

  it("team spaces: non-guests read, writers edit; guests need membership", () => {
    expect(accessFor(member, { visibility: "team" }, null)).toBe("edit");
    expect(accessFor(reader, { visibility: "team" }, null)).toBe("read");
    expect(accessFor(guest, { visibility: "team" }, null)).toBe("none");
    expect(accessFor(guest, { visibility: "team" }, "viewer")).toBe("read");
  });

  it("private spaces: members only, admins always", () => {
    expect(accessFor(member, { visibility: "private" }, null)).toBe("none");
    expect(accessFor(member, { visibility: "private" }, "viewer")).toBe("read");
    expect(accessFor(member, { visibility: "private" }, "manager")).toBe("manage");
    expect(accessFor(reader, { visibility: "private" }, "editor")).toBe("read");
    expect(accessFor(admin, { visibility: "private" }, null)).toBe("manage");
  });

  it("archived spaces cannot be edited, and without docs.access nothing opens", () => {
    expect(accessFor(member, { visibility: "team", archivedAt: new Date() }, "editor")).toBe("read");
    expect(accessFor(who("member", []), { visibility: "team" }, "manager")).toBe("none");
  });
});
