import path from 'path';
import { Dirent, promises as fs } from 'fs';

import OpenAI from 'openai';
import { createLogger } from '@repolens/shared-utils';
import { z } from 'zod';
import {
  ReviewAnswer,
  ReviewFinding,
  ReviewResults,
  ReviewSeverity,
} from '@repolens/shared-types';

import { reviewQuestions } from '../review/questions';
import { reviewAnswerSchema, reviewRefSchema, reviewResultsSchema } from '../review/schemas';
import { calculateRiskSummary } from './riskScoring';

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  service: 'vibe-review-service',
});

const MAX_FILE_BYTES = 300 * 1024;
const MAX_FILES = 300;
const SCAN_INCLUDE_DEPRIORITIZED = (process.env.SCAN_INCLUDE_DEPRIORITIZED ?? 'false').toLowerCase() === 'true';
const REVIEW_TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS ?? 600000);
const REVIEW_MODEL = process.env.REVIEW_MODEL ?? 'codex-mini-latest';
const REVIEW_USE_CODEX = (process.env.REVIEW_USE_CODEX ?? 'true').toLowerCase() !== 'false';
const REVIEW_MAX_CONTEXT_CHARS = Number(process.env.REVIEW_MAX_CONTEXT_CHARS ?? 180_000);
const REVIEW_MAX_FILE_CHARS = Number(process.env.REVIEW_MAX_FILE_CHARS ?? 4_000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim();
const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.idea',
  '.vscode',
]);
const priorityRootDirectories = ['src', 'lib', 'apps', 'server'] as const;
const deprioritizedDirectories = new Set(['examples', 'example', 'test', 'tests', 'docs', 'mocks', '__mocks__']);
const readableExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.md',
  '.java',
  '.go',
  '.py',
  '.rb',
  '.php',
  '.cs',
  '.rs',
  '.kt',
  '.swift',
  '.sql',
  '.html',
  '.css',
  '.scss',
]);
const normalizedSeverities: ReviewSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'UNKNOWN'];
const aiAnswerSchema = z.object({
  severity: z.string().min(1),
  answer: z.string().min(1),
  refs: z.array(reviewRefSchema).default([]),
});

type RepoFile = {
  path: string;
  content: string;
  lines: string[];
};

type ScanStats = {
  priorityPassCount: number;
  nonPriorityPassCount: number;
};

type ScanResult = {
  files: RepoFile[];
  stats: ScanStats;
};

type ScanRepoFilesOptions = {
  maxFiles?: number;
  maxFileBytes?: number;
  includeDeprioritized?: boolean;
};

type Finding = ReviewFinding;

type RuleAssessment = { severity: ReviewSeverity; findings: Finding[]; answer: string };

const openai = OPENAI_API_KEY
  ? new OpenAI({
      apiKey: OPENAI_API_KEY,
    })
  : null;

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string) =>
  Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), timeoutMs),
    ),
  ]);

const isText = (content: string) => !content.includes('\u0000');

const sortDirEntries = (entries: Dirent[]) =>
  entries.slice().sort((a, b) => a.name.localeCompare(b.name));

export const scanRepoFiles = async (
  repoRoot: string,
  options: ScanRepoFilesOptions = {},
): Promise<ScanResult> => {
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const includeDeprioritized = options.includeDeprioritized ?? SCAN_INCLUDE_DEPRIORITIZED;
  const files: RepoFile[] = [];
  const stats: ScanStats = {
    priorityPassCount: 0,
    nonPriorityPassCount: 0,
  };

  const addFile = async (absolutePath: string, pass: keyof ScanStats) => {
    if (files.length >= maxFiles) {
      return;
    }
    const filename = path.basename(absolutePath);
    const extension = path.extname(filename).toLowerCase();
    if (!readableExtensions.has(extension) && filename !== 'README') {
      return;
    }
    try {
      const fileStats = await fs.stat(absolutePath);
      if (fileStats.size <= 0 || fileStats.size > maxFileBytes) {
        return;
      }
      const content = await fs.readFile(absolutePath, 'utf8');
      if (!isText(content)) {
        return;
      }
      files.push({
        path: path.relative(repoRoot, absolutePath),
        content,
        lines: content.split(/\r?\n/),
      });
      stats[pass] += 1;
    } catch {
      // Ignore unreadable files and continue real scan.
    }
  };

  const walk = async (currentDir: string, pass: keyof ScanStats) => {
    if (files.length >= maxFiles) {
      return;
    }
    const entries = sortDirEntries(await fs.readdir(currentDir, { withFileTypes: true }));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        return;
      }
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) {
          continue;
        }
        if (!includeDeprioritized && deprioritizedDirectories.has(entry.name)) {
          continue;
        }
        await walk(absolutePath, pass);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      await addFile(absolutePath, pass);
    }
  };

  for (const rootName of priorityRootDirectories) {
    if (files.length >= maxFiles) {
      break;
    }
    const priorityPath = path.join(repoRoot, rootName);
    try {
      const dirStats = await fs.stat(priorityPath);
      if (!dirStats.isDirectory()) {
        continue;
      }
      await walk(priorityPath, 'priorityPassCount');
    } catch {
      // Ignore missing priority roots.
    }
  }

  if (files.length < maxFiles) {
    const rootEntries = sortDirEntries(await fs.readdir(repoRoot, { withFileTypes: true }));
    for (const entry of rootEntries) {
      if (files.length >= maxFiles) {
        break;
      }
      const absolutePath = path.join(repoRoot, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) {
          continue;
        }
        if (priorityRootDirectories.includes(entry.name as (typeof priorityRootDirectories)[number])) {
          continue;
        }
        if (!includeDeprioritized && deprioritizedDirectories.has(entry.name)) {
          continue;
        }
        await walk(absolutePath, 'nonPriorityPassCount');
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      await addFile(absolutePath, 'nonPriorityPassCount');
    }
  }

  return { files, stats };
};

const findLine = (lines: string[], test: (line: string) => boolean) => {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && test(line)) {
      return index + 1;
    }
  }
  return 1;
};

const formatCodeSnippet = (lines: string[], lineNumber: number, context: number = 1) => {
  const start = Math.max(1, lineNumber - context);
  const end = Math.min(lines.length, lineNumber + context);
  const snippetLines: string[] = [];
  for (let current = start; current <= end; current += 1) {
    const line = lines[current - 1] ?? '';
    snippetLines.push(`${String(current).padStart(4, ' ')} | ${line}`);
  }
  return snippetLines.join('\n');
};

const createFinding = (
  file: RepoFile,
  line: number,
  reason: string,
  details: string,
  recommendation: string,
): Finding => ({
  path: file.path,
  line,
  reason,
  details,
  recommendation,
  codeSnippet: formatCodeSnippet(file.lines, line),
});

const toRefs = (findings: Finding[]) =>
  findings.slice(0, 20).map((finding) => ({ path: finding.path, line: finding.line }));

const normalizeSeverity = (value: string): ReviewSeverity => {
  const upper = value.toUpperCase();
  return (normalizedSeverities.find((severity) => severity === upper) ?? 'UNKNOWN') as ReviewSeverity;
};

const buildRepoContext = (repoFiles: RepoFile[]): string => {
  const header = [
    `Repository files included for review: ${repoFiles.length}`,
    `Each file is truncated to at most ${REVIEW_MAX_FILE_CHARS} characters.`,
  ].join('\n');

  let remaining = Math.max(REVIEW_MAX_CONTEXT_CHARS - header.length, 0);
  const chunks: string[] = [];
  let includedCount = 0;

  for (const file of repoFiles) {
    if (remaining <= 0) {
      break;
    }
    const truncated = file.content.slice(0, REVIEW_MAX_FILE_CHARS);
    const fileChunk = [
      `\nFILE: ${file.path}`,
      '```',
      truncated,
      '```',
    ].join('\n');

    if (fileChunk.length > remaining) {
      break;
    }

    chunks.push(fileChunk);
    remaining -= fileChunk.length;
    includedCount += 1;
  }

  const omittedCount = repoFiles.length - includedCount;
  const footer =
    omittedCount > 0
      ? `\n\n${omittedCount} file(s) omitted due to context limit ${REVIEW_MAX_CONTEXT_CHARS} chars.`
      : '';

  return `${header}${chunks.join('')}${footer}`;
};

const extractResponseText = (response: unknown): string => {
  const value = response as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ text?: unknown }> }>;
  };

  if (typeof value.output_text === 'string' && value.output_text.trim().length > 0) {
    return value.output_text.trim();
  }

  const chunks: string[] = [];
  for (const item of value.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string' && content.text.trim().length > 0) {
        chunks.push(content.text.trim());
      }
    }
  }

  return chunks.join('\n').trim();
};

const parseJsonObject = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error('INVALID_MODEL_JSON');
    }
    return JSON.parse(raw.slice(start, end + 1));
  }
};

const answerWithCodex = async (
  jobId: string,
  question: (typeof reviewQuestions)[number],
  repoContext: string,
): Promise<ReviewAnswer> => {
  if (!openai) {
    throw new Error('OPENAI_API_KEY_MISSING');
  }

  const prompt = [
    'You are a senior application security and architecture reviewer.',
    'Analyze the provided repository snippets and answer exactly in JSON format:',
    '{"severity":"CRITICAL|HIGH|MEDIUM|LOW|INFO|UNKNOWN","answer":"string","refs":[{"path":"string","line":number}]}.',
    'Rules:',
    '- Keep answer focused on concrete findings.',
    '- Use refs for specific files/lines when available.',
    '- If insufficient evidence, set severity to INFO or UNKNOWN and explain what is missing.',
    '',
    `Question ID: ${question.id}`,
    `Question Title: ${question.title}`,
    `Question Category: ${question.category}`,
    `Question Prompt: ${question.prompt}`,
    '',
    repoContext,
  ].join('\n');

  const response = await openai.responses.create({
    model: REVIEW_MODEL,
    input: prompt,
  });

  const outputText = extractResponseText(response);
  if (!outputText) {
    throw new Error('EMPTY_CODEX_RESPONSE');
  }

  const parsed = aiAnswerSchema.parse(parseJsonObject(outputText));

  logger.info(
    {
      jobId,
      stage: 'REVIEWING',
      questionId: question.id,
      provider: 'codex',
      model: REVIEW_MODEL,
      refsCount: parsed.refs.length,
    },
    'Codex response parsed successfully',
  );

  return {
    id: question.id,
    title: question.title,
    category: question.category,
    severity: normalizeSeverity(parsed.severity),
    answer: parsed.answer,
    refs: parsed.refs.slice(0, 20),
  };
};

const summarizeNoIssues = (repoFiles: RepoFile[], justification: string) =>
  `Inspected ${repoFiles.length} readable files. ${justification}`;

const assessSqlInjection = (repoFiles: RepoFile[]): { severity: ReviewSeverity; findings: Finding[]; answer: string } => {
  const findings: Finding[] = [];
  const patterns: Array<{ regex: RegExp; reason: string; details: string; recommendation: string }> = [
    {
      regex: /(query|execute)\s*\(\s*`[^`]*\$\{/i,
      reason: 'Dynamic SQL template interpolation in query execution',
      details:
        'Template literal interpolation can splice unsanitized user input directly into SQL text, bypassing query parameterization.',
      recommendation:
        'Use parameterized queries or ORM bind parameters and keep user input out of SQL string construction.',
    },
    {
      regex: /(query|execute)\s*\(\s*["'][^"']*\+/i,
      reason: 'String concatenation used to build SQL query',
      details:
        'SQL assembled with string concatenation increases injection risk when values flow from request or other untrusted input.',
      recommendation:
        'Replace concatenation with placeholders and pass values in the query parameter array/object.',
    },
    {
      regex: /sequelize\.query\s*\(.*\+/i,
      reason: 'sequelize.query appears to use concatenated SQL',
      details:
        'Raw sequelize.query with concatenated text may execute attacker-controlled SQL fragments if any value is untrusted.',
      recommendation:
        'Use replacements/bind options in sequelize.query and validate input constraints before query execution.',
    },
  ];

  for (const file of repoFiles) {
    for (const pattern of patterns) {
      if (!pattern.regex.test(file.content)) {
        continue;
      }
      const line = findLine(file.lines, (lineContent) => pattern.regex.test(lineContent));
      findings.push({
        path: file.path,
        line,
        reason: pattern.reason,
        details: pattern.details,
        recommendation: pattern.recommendation,
        codeSnippet: formatCodeSnippet(file.lines, line),
      });
    }
  }

  if (findings.length === 0) {
    return {
      severity: 'INFO',
      findings,
      answer: summarizeNoIssues(
        repoFiles,
        'No dynamic SQL construction pattern was detected in scanned query calls.',
      ),
    };
  }

  return {
    severity: findings.length > 2 ? 'HIGH' : 'MEDIUM',
    findings,
    answer: `Detected ${findings.length} SQL injection risk indicator(s): ${findings
      .slice(0, 5)
      .map((finding) => `${finding.reason} at ${finding.path}:${finding.line}`)
      .join('; ')}.`,
  };
};

const assessXss = (repoFiles: RepoFile[]): { severity: ReviewSeverity; findings: Finding[]; answer: string } => {
  const findings: Finding[] = [];
  const patterns: Array<{ regex: RegExp; reason: string; details: string; recommendation: string }> = [
    {
      regex: /dangerouslySetInnerHTML/,
      reason: 'dangerouslySetInnerHTML is used and requires strict sanitization',
      details:
        'Raw HTML rendering can execute attacker-controlled scripts if the content source is not sanitized and encoded correctly.',
      recommendation:
        'Avoid raw HTML where possible; otherwise sanitize with a trusted sanitizer and enforce a strict content security policy.',
    },
    {
      regex: /\.innerHTML\s*=/,
      reason: 'Direct DOM innerHTML assignment can allow script injection',
      details:
        'Assigning untrusted strings to innerHTML can inject script-capable markup into the DOM.',
      recommendation:
        'Use textContent for plain text output, or sanitize before assigning to innerHTML.',
    },
    {
      regex: /v-html\s*=/,
      reason: 'Vue v-html renders raw HTML and can introduce XSS',
      details:
        'v-html bypasses default escaping and can render attacker-supplied markup directly.',
      recommendation:
        'Prefer escaped template rendering; if v-html is required, sanitize input with an allowlist-based sanitizer.',
    },
  ];

  for (const file of repoFiles) {
    for (const pattern of patterns) {
      if (!pattern.regex.test(file.content)) {
        continue;
      }
      const line = findLine(file.lines, (lineContent) => pattern.regex.test(lineContent));
      findings.push({
        path: file.path,
        line,
        reason: pattern.reason,
        details: pattern.details,
        recommendation: pattern.recommendation,
        codeSnippet: formatCodeSnippet(file.lines, line),
      });
    }
  }

  if (findings.length === 0) {
    return {
      severity: 'INFO',
      findings,
      answer: summarizeNoIssues(
        repoFiles,
        'No raw HTML rendering pattern (innerHTML/dangerouslySetInnerHTML/v-html) was found.',
      ),
    };
  }

  return {
    severity: findings.length > 2 ? 'HIGH' : 'MEDIUM',
    findings,
    answer: `Detected ${findings.length} XSS risk indicator(s): ${findings
      .slice(0, 5)
      .map((finding) => `${finding.reason} at ${finding.path}:${finding.line}`)
      .join('; ')}.`,
  };
};

const assessAuthz = (repoFiles: RepoFile[]): { severity: ReviewSeverity; findings: Finding[]; answer: string } => {
  const findings: Finding[] = [];
  const routePattern = /(app|router)\.(get|post|put|patch|delete)\s*\(/i;
  const authPattern = /(auth|jwt|passport|requireAuth|authorize|rbac)/i;

  for (const file of repoFiles) {
    if (!routePattern.test(file.content)) {
      continue;
    }
    const hasAuthMarker = authPattern.test(file.content);
    if (hasAuthMarker) {
      continue;
    }
    findings.push({
      ...createFinding(
        file,
        findLine(file.lines, (line) => routePattern.test(line)),
        'Route handlers found without visible auth/authz middleware markers in same file',
        'This route file defines request handlers but no obvious authentication/authorization checks are present nearby.',
        'Add explicit auth middleware and role/ownership checks on sensitive endpoints.',
      ),
    });
  }

  if (findings.length === 0) {
    return {
      severity: 'INFO',
      findings,
      answer: summarizeNoIssues(
        repoFiles,
        'Route definitions in scanned files include authentication/authorization markers or no routes were found.',
      ),
    };
  }

  return {
    severity: findings.length > 3 ? 'HIGH' : 'MEDIUM',
    findings,
    answer: `Detected ${findings.length} authz coverage gap indicator(s): ${findings
      .slice(0, 5)
      .map((finding) => `${finding.reason} at ${finding.path}:${finding.line}`)
      .join('; ')}.`,
  };
};

const assessSecrets = (repoFiles: RepoFile[]): { severity: ReviewSeverity; findings: Finding[]; answer: string } => {
  const findings: Finding[] = [];
  const patterns: Array<{ regex: RegExp; reason: string; details: string; recommendation: string }> = [
    {
      regex: /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*['"][^'"]{8,}['"]/i,
      reason: 'Potential hardcoded credential/token value',
      details:
        'The pattern suggests a secret-like value is embedded in source/config, which can leak through VCS, logs, or package artifacts.',
      recommendation:
        'Move secrets to environment variables or a secret manager and rotate any exposed values.',
    },
    {
      regex: /-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----/,
      reason: 'Private key material present in repository file',
      details:
        'Private key material in a repository is highly sensitive and can allow unauthorized access if compromised.',
      recommendation:
        'Remove committed key material, rotate affected keys, and store credentials in secure secret storage.',
    },
  ];

  for (const file of repoFiles) {
    for (const pattern of patterns) {
      if (!pattern.regex.test(file.content)) {
        continue;
      }
      const line = findLine(file.lines, (lineContent) => pattern.regex.test(lineContent));
      findings.push({
        path: file.path,
        line,
        reason: pattern.reason,
        details: pattern.details,
        recommendation: pattern.recommendation,
        codeSnippet: formatCodeSnippet(file.lines, line),
      });
    }
  }

  if (findings.length === 0) {
    return {
      severity: 'INFO',
      findings,
      answer: summarizeNoIssues(
        repoFiles,
        'No obvious hardcoded credentials or private key markers were detected in scanned text files.',
      ),
    };
  }

  return {
    severity: findings.length > 1 ? 'HIGH' : 'MEDIUM',
    findings,
    answer: `Detected ${findings.length} secrets exposure indicator(s): ${findings
      .slice(0, 5)
      .map((finding) => `${finding.reason} at ${finding.path}:${finding.line}`)
      .join('; ')}.`,
  };
};

const parseDependencyNames = (repoFiles: RepoFile[]) => {
  const names = new Set<string>();
  const nonPinned: string[] = [];

  for (const file of repoFiles) {
    if (!file.path.endsWith('package.json')) {
      continue;
    }
    try {
      const parsed = JSON.parse(file.content) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const combined = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
      for (const [name, version] of Object.entries(combined)) {
        names.add(name);
        if (version === '*' || version.toLowerCase() === 'latest') {
          nonPinned.push(`${name}@${version}`);
        }
      }
    } catch {
      // Ignore malformed package.json files in this pass.
    }
  }

  return { names, nonPinned };
};

const assessDependencies = (
  repoFiles: RepoFile[],
): { severity: ReviewSeverity; findings: Finding[]; answer: string } => {
  const findings: Finding[] = [];
  const riskyPackages = new Set(['event-stream', 'node-serialize', 'request']);
  const { names, nonPinned } = parseDependencyNames(repoFiles);

  for (const packageName of names) {
    if (!riskyPackages.has(packageName)) {
      continue;
    }
    const file = repoFiles.find((item) => item.path.endsWith('package.json'));
    const line = file ? findLine(file.lines, (lineText) => lineText.includes(`"${packageName}"`)) : 1;
    findings.push({
      path: file?.path ?? 'package.json',
      line,
      reason: `Dependency ${packageName} is considered high-risk/deprecated`,
      details:
        'The dependency appears on a high-risk/deprecated watchlist and may introduce known security or maintenance risks.',
      recommendation:
        'Replace with a maintained alternative and run dependency vulnerability scanning as part of CI.',
      codeSnippet: file ? formatCodeSnippet(file.lines, line) : '   1 | package.json not found in scanned files',
    });
  }

  for (const item of nonPinned) {
    const packageName = item.split('@')[0] ?? item;
    const file = repoFiles.find((repoFile) => repoFile.path.endsWith('package.json'));
    const line = file ? findLine(file.lines, (lineText) => lineText.includes(packageName)) : 1;
    findings.push({
      path: file?.path ?? 'package.json',
      line,
      reason: `Dependency version is non-pinned (${item})`,
      details:
        'Using wildcard/latest versions can pull unreviewed releases and make builds non-reproducible.',
      recommendation:
        'Pin exact or constrained versions and use lockfile verification in CI.',
      codeSnippet: file ? formatCodeSnippet(file.lines, line) : '   1 | package.json not found in scanned files',
    });
  }

  if (findings.length === 0) {
    return {
      severity: 'INFO',
      findings,
      answer: summarizeNoIssues(
        repoFiles,
        'No risky package names from the configured watchlist and no wildcard/latest dependency versions were found.',
      ),
    };
  }

  return {
    severity: findings.length > 2 ? 'MEDIUM' : 'LOW',
    findings,
    answer: `Detected ${findings.length} dependency hygiene indicator(s): ${findings
      .slice(0, 5)
      .map((finding) => `${finding.reason} at ${finding.path}:${finding.line}`)
      .join('; ')}.`,
  };
};

const summarizeReview = (repoFiles: RepoFile[], answers: ReviewAnswer[]) => {
  const actionable = answers.filter((answer) => answer.severity !== 'INFO');
  if (actionable.length === 0) {
    return {
      severity: 'INFO' as ReviewSeverity,
      findings: [] as Finding[],
      answer: summarizeNoIssues(
        repoFiles,
        'All analyzed questions returned INFO because no risk indicators were detected in scanned files.',
      ),
    };
  }

  return {
    severity: 'MEDIUM' as ReviewSeverity,
    findings: actionable.flatMap((answer) =>
      (answer.findings ?? []).slice(0, 3).map((finding) => ({
        ...finding,
        reason: `${answer.id} reported ${answer.severity}: ${finding.reason}`,
      })),
    ),
    answer: `Found ${actionable.length} question(s) with non-INFO severity: ${actionable
      .map((answer) => `${answer.id}=${answer.severity}`)
      .join(', ')}.`,
  };
};

const answerWithRules = (
  question: (typeof reviewQuestions)[number],
  repoFiles: RepoFile[],
  answers: ReviewAnswer[],
): ReviewAnswer => {
  const assessment: RuleAssessment =
    question.id === 'security-sql-injection'
      ? assessSqlInjection(repoFiles)
      : question.id === 'security-xss'
        ? assessXss(repoFiles)
        : question.id === 'security-authz'
          ? assessAuthz(repoFiles)
          : question.id === 'security-secrets'
            ? assessSecrets(repoFiles)
            : question.id === 'security-dependency-vulns'
              ? assessDependencies(repoFiles)
              : summarizeReview(repoFiles, answers);

  return {
    id: question.id,
    title: question.title,
    category: question.category,
    severity: assessment.severity,
    answer: assessment.answer,
    refs: toRefs(assessment.findings),
    findings: assessment.findings.slice(0, 10),
  };
};

// Stores results while preserving partial progress.
export const formatAndStoreResults = async (jobId: string, results: ReviewAnswer[]) => {
  const normalizedAnswers = results.map((result) => reviewAnswerSchema.parse(result));
  const existing: ReviewResults = {
    questions: normalizedAnswers,
    riskSummary: calculateRiskSummary(normalizedAnswers),
    reviewEngine: REVIEW_USE_CODEX ? 'OPENAI' : 'RULES',
  };

  logger.info(
    {
      jobId,
      stage: 'REVIEWING',
      questionCount: normalizedAnswers.length,
      riskLevel: existing.riskSummary?.level,
      riskScore: existing.riskSummary?.score,
      reviewEngine: existing.reviewEngine,
    },
    'Computed review risk summary from real findings',
  );

  return reviewResultsSchema.parse(existing);
};

// Runs the review questions using repository files only.
export const runReviewForJob = async (jobId: string, repoRoot: string): Promise<ReviewAnswer[]> => {
  const answers: ReviewAnswer[] = [];

  const run = async () => {
    if (REVIEW_USE_CODEX && !openai) {
      throw new Error('OPENAI_API_KEY_MISSING');
    }

    const scanResult = await scanRepoFiles(repoRoot);
    const repoFiles = scanResult.files;
    if (repoFiles.length === 0) {
      throw new Error('NO_READABLE_FILES');
    }
    const repoContext = buildRepoContext(repoFiles);

    logger.info(
      {
        jobId,
        stage: 'REVIEWING',
        fileCount: repoFiles.length,
        samplePaths: repoFiles.slice(0, 10).map((file) => file.path),
        priorityPassCount: scanResult.stats.priorityPassCount,
        nonPriorityPassCount: scanResult.stats.nonPriorityPassCount,
        reviewEngine: REVIEW_USE_CODEX ? 'codex' : 'rules',
        model: REVIEW_USE_CODEX ? REVIEW_MODEL : undefined,
      },
      'Loaded real repository files for analysis',
    );

    for (const question of reviewQuestions) {
      try {
        logger.info(
          { jobId, stage: 'REVIEWING', questionId: question.id },
          'Starting question analysis',
        );

        const answer = REVIEW_USE_CODEX
          ? await answerWithCodex(jobId, question, repoContext)
          : answerWithRules(question, repoFiles, answers);

        answers.push(answer);
        logger.info(
          {
            jobId,
            stage: 'REVIEWING',
            questionId: question.id,
            severity: answer.severity,
            findingCount: answer.refs.length,
          },
          'Completed question analysis',
        );
      } catch (error) {
        const partialError = new Error('REVIEW_QUESTION_FAILED');
        (partialError as Error & { partialResults?: ReviewAnswer[] }).partialResults = answers;
        logger.error({ error, jobId, questionId: question.id }, 'Question review failed');
        throw partialError;
      }
    }
  };

  await withTimeout(run(), REVIEW_TIMEOUT_MS, 'REVIEW');
  return answers;
};
