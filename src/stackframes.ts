import type { StackFrame } from "./types";

/**
 * Locating the first *application* frame in a stack trace, across languages.
 *
 * This is the most load-bearing parser in the product: the frame it returns is
 * what the fingerprint is built from, what blame is scoped to, and what the
 * brief cites. It runs on every event ahead of the cost gates, so it must stay
 * deterministic and free — no model call. A model would also make the
 * fingerprint non-deterministic, which would destroy dedupe outright.
 *
 * The JavaScript matcher is deliberately first and byte-identical to the
 * original: any change to how an existing trace parses would change its
 * fingerprint, and every live incident would re-mint as a new one.
 */

interface Matcher {
  readonly language: string;
  /** Frames this language contributes from a single line. */
  readonly line: RegExp;
  /** Pull (fn, file, line) out of a match. */
  extract(m: RegExpExecArray, previousLine: string): StackFrame | null;
  /** True when the frame belongs to a dependency rather than the application. */
  isDependency(frame: StackFrame): boolean;
}

const has = (s: string, ...needles: string[]) =>
  needles.some((n) => s.toLowerCase().includes(n));

/** V8 and friends: `at fn (/app/src/f.ts:142:31)`, or a bare `at /app/f.js:1:2`. */
const JAVASCRIPT: Matcher = {
  language: "javascript",
  line: /^\s*at\s+(?:async\s+)?(.+?)\s+\((.+?):(\d+):(\d+)\)\s*$/,
  extract(m) {
    return { fn: m[1].trim(), file: m[2], line: Number(m[3]) };
  },
  isDependency: (f) => /[/\\]node_modules[/\\]/.test(f.file),
};

/** CPython: `  File "/app/checkout/pricing.py", line 142, in apply_promotion`. */
const PYTHON: Matcher = {
  language: "python",
  line: /^\s*File\s+"(.+?)",\s+line\s+(\d+),\s+in\s+(.+?)\s*$/,
  extract(m) {
    return { fn: m[3].trim(), file: m[1], line: Number(m[2]) };
  },
  isDependency: (f) =>
    has(f.file, "/site-packages/", "/dist-packages/", "/lib/python", "\\site-packages\\"),
};

/** JVM: `\tat com.acme.checkout.Pricing.apply(Pricing.java:142)`. */
const JVM: Matcher = {
  language: "jvm",
  line: /^\s*at\s+([\w$.]+)\(([\w$]+\.(?:java|kt|scala|groovy)):(\d+)\)\s*$/,
  extract(m) {
    return { fn: m[1], file: m[2], line: Number(m[3]) };
  },
  // The JVM reports a bare filename, so ownership has to come from the package.
  isDependency: (f) =>
    /^(java|javax|jakarta|jdk|sun|com\.sun|scala|kotlin|groovy|org\.(springframework|hibernate|apache|jboss|junit|slf4j|eclipse)|io\.(netty|micrometer))\./.test(
      f.fn,
    ),
};

/** .NET: `   at Acme.Checkout.Pricing.Apply() in /app/Pricing.cs:line 142`. */
const DOTNET: Matcher = {
  language: "dotnet",
  line: /^\s*at\s+(.+?)\s+in\s+(.+?):line\s+(\d+)\s*$/,
  extract(m) {
    return { fn: m[1].trim(), file: m[2], line: Number(m[3]) };
  },
  isDependency: (f) => /^(System|Microsoft|Newtonsoft|NuGet)\./.test(f.fn),
};

/** Ruby: `/app/checkout/pricing.rb:142:in 'apply_promotion'`. */
const RUBY: Matcher = {
  language: "ruby",
  line: /^\s*(?:from\s+)?(.+?\.rb):(\d+):in\s+[`'"](.+?)['"]\s*$/,
  extract(m) {
    return { fn: m[3].trim(), file: m[1], line: Number(m[2]) };
  },
  isDependency: (f) => has(f.file, "/gems/", "/ruby/", "/bundler/"),
};

/** PHP: `#0 /app/Pricing.php(142): applyPromotion()`. */
const PHP: Matcher = {
  language: "php",
  line: /^\s*#\d+\s+(.+?\.php)\((\d+)\):\s*(.+?)\s*$/,
  extract(m) {
    return { fn: m[3].trim(), file: m[1], line: Number(m[2]) };
  },
  isDependency: (f) => has(f.file, "/vendor/"),
};

/**
 * Go splits a frame over two lines — the function, then a tab-indented
 * `file:line +0xoffset`. The function comes from the line above.
 */
const GO: Matcher = {
  language: "go",
  line: /^\s+(\/.+?\.go):(\d+)(?:\s+\+0x[0-9a-f]+)?\s*$/,
  extract(m, previousLine) {
    const fn = previousLine.trim().replace(/\(.*\)$/, "") || "unknown";
    return { fn, file: m[1], line: Number(m[2]) };
  },
  isDependency: (f) =>
    has(f.file, "/usr/local/go/src/", "/go/pkg/mod/", "/vendor/") ||
    /^(runtime|net\/http|internal)\./.test(f.fn),
};

/**
 * JavaScript stays first so existing traces parse exactly as before. The rest
 * are ordered by how specific their pattern is, so a line cannot be claimed by
 * a looser matcher belonging to another language.
 */
const MATCHERS: readonly Matcher[] = [JAVASCRIPT, PYTHON, JVM, DOTNET, PHP, RUBY, GO];

/**
 * The first frame attributable to the application. Dependency frames are
 * skipped, because "it broke inside express" is never the useful answer.
 *
 * If every frame looks like a dependency the deepest one is returned rather
 * than nothing — a located frame in a vendored library still beats falling back
 * to message-only grouping.
 */
export function firstAppFrame(stackTrace: string): StackFrame | null {
  const lines = stackTrace.split("\n");
  let firstAny: StackFrame | null = null;

  for (let i = 0; i < lines.length; i++) {
    for (const matcher of MATCHERS) {
      const m = matcher.line.exec(lines[i]);
      if (!m) continue;

      const frame = matcher.extract(m, i > 0 ? lines[i - 1] : "");
      if (!frame || !Number.isFinite(frame.line)) continue;

      if (!firstAny) firstAny = frame;
      if (!matcher.isDependency(frame)) return frame;
      break; // this line belongs to this language; do not try looser matchers
    }
  }

  return firstAny;
}

/** Which language a trace parsed as, for display. Null when nothing matched. */
export function detectLanguage(stackTrace: string): string | null {
  for (const line of stackTrace.split("\n")) {
    for (const matcher of MATCHERS) {
      if (matcher.line.test(line)) return matcher.language;
    }
  }
  return null;
}
