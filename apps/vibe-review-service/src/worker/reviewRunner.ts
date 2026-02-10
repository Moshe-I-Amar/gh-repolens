import path from 'path';
import { promises as fs } from 'fs';

import { createLogger } from '@repolens/shared-utils';
import { ReviewAnswer, ReviewResults, ReviewSeverity } from '@repolens/shared-types';

import { reviewQuestions } from '../review/questions';
import { reviewAnswerSchema, reviewResultsSchema } from '../review/schemas';
import { calculateRiskSummary } from './riskScoring';

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  service: 'vibe-review-service',
});

const MAX_FILE_BYTES = 300 * 1024;
const MAX_FILES = 300;
const REVIEW_TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS ?? 600000);
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

type RepoFile = {
  path: string;
  content: string;
  lines: string[];
};

type Finding = {
  path: string;
  line: number;
  reason: string;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string) =>
  Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), timeoutMs),
    ),
  ]);

const isText = (content: string) => !content.includes('\u0000');

const scanRepoFiles = async (repoRoot: string): Promise<RepoFile[]> => {
  const files: RepoFile[] = [];

  const walk = async (currentDir: string) => {
    if (files.length >= MAX_FILES) {
      return;
    }
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        return;
      }
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) {
          continue;
        }
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (!readableExtensions.has(extension) && entry.name !== 'README') {
        continue;
      }
      try {
        const stats = await fs.stat(absolutePath);
        if (stats.size <= 0 || stats.size > MAX_FILE_BYTES) {
          continue;
        }
        const content = await fs.readFile(absolutePath, 'utf8');
        if (!isText(content)) {
          continue;
        }
        files.push({
          path: path.relative(repoRoot, absolutePath),
          content,
          lines: content.split(/\r?\n/),
        });
      } catch {
        // Ignore unreadable files and continue real scan.
      }
    }
  };

  await walk(repoRoot);
  return files;
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

const toRefs = (findings: Finding[]) =>
  findings.slice(0, 20).map((finding) => ({ path: finding.path, line: finding.line }));

const summarizeNoIssues = (repoFiles: RepoFile[], justification: string) =>
  `Inspected ${repoFiles.length} readable files. ${justification}`;

const assessSqlInjection = (repoFiles: RepoFile[]): { severity: ReviewSeverity; findings: Finding[]; answer: string } => {
  const findings: Finding[] = [];
  const patterns: Array<{ regex: RegExp; reason: string }> = [
    {
      regex: /(query|execute)\s*\(\s*`[^`]*\$\{/i,
      reason: 'Dynamic SQL template interpolation in query execution',
    },
    {
      regex: /(query|execute)\s*\(\s*["'][^"']*\+/i,
      reason: 'String concatenation used to build SQL query',
    },
    {
      regex: /sequelize\.query\s*\(.*\+/i,
      reason: 'sequelize.query appears to use concatenated SQL',
    },
  ];

  for (const file of repoFiles) {
    for (const pattern of patterns) {
      if (!pattern.regex.test(file.content)) {
        continue;
      }
      findings.push({
        path: file.path,
        line: findLine(file.lines, (line) => pattern.regex.test(line)),
        reason: pattern.reason,
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
  const patterns: Array<{ regex: RegExp; reason: string }> = [
    {
      regex: /dangerouslySetInnerHTML/,
      reason: 'dangerouslySetInnerHTML is used and requires strict sanitization',
    },
    {
      regex: /\.innerHTML\s*=/,
      reason: 'Direct DOM innerHTML assignment can allow script injection',
    },
    {
      regex: /v-html\s*=/,
      reason: 'Vue v-html renders raw HTML and can introduce XSS',
    },
  ];

  for (const file of repoFiles) {
    for (const pattern of patterns) {
      if (!pattern.regex.test(file.content)) {
        continue;
      }
      findings.push({
        path: file.path,
        line: findLine(file.lines, (line) => pattern.regex.test(line)),
        reason: pattern.reason,
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
      path: file.path,
      line: findLine(file.lines, (line) => routePattern.test(line)),
      reason: 'Route handlers found without visible auth/authz middleware markers in same file',
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
  const patterns: Array<{ regex: RegExp; reason: string }> = [
    {
      regex: /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*['"][^'"]{8,}['"]/i,
      reason: 'Potential hardcoded credential/token value',
    },
    {
      regex: /-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----/,
      reason: 'Private key material present in repository file',
    },
  ];

  for (const file of repoFiles) {
    for (const pattern of patterns) {
      if (!pattern.regex.test(file.content)) {
        continue;
      }
      findings.push({
        path: file.path,
        line: findLine(file.lines, (line) => pattern.regex.test(line)),
        reason: pattern.reason,
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
    findings.push({
      path: file?.path ?? 'package.json',
      line: file ? findLine(file.lines, (line) => line.includes(`"${packageName}"`)) : 1,
      reason: `Dependency ${packageName} is considered high-risk/deprecated`,
    });
  }

  for (const item of nonPinned) {
    const packageName = item.split('@')[0] ?? item;
    const file = repoFiles.find((repoFile) => repoFile.path.endsWith('package.json'));
    findings.push({
      path: file?.path ?? 'package.json',
      line: file ? findLine(file.lines, (line) => line.includes(packageName)) : 1,
      reason: `Dependency version is non-pinned (${item})`,
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
      answer.refs.slice(0, 3).map((ref) => ({
        path: ref.path,
        line: ref.line ?? 1,
        reason: `${answer.id} reported ${answer.severity}`,
      })),
    ),
    answer: `Found ${actionable.length} question(s) with non-INFO severity: ${actionable
      .map((answer) => `${answer.id}=${answer.severity}`)
      .join(', ')}.`,
  };
};

// Stores results while preserving partial progress.
export const formatAndStoreResults = async (jobId: string, results: ReviewAnswer[]) => {
  const normalizedAnswers = results.map((result) => reviewAnswerSchema.parse(result));
  const existing: ReviewResults = {
    questions: normalizedAnswers,
    riskSummary: calculateRiskSummary(normalizedAnswers),
  };

  logger.info(
    {
      jobId,
      stage: 'REVIEWING',
      questionCount: normalizedAnswers.length,
      riskLevel: existing.riskSummary?.level,
      riskScore: existing.riskSummary?.score,
    },
    'Computed review risk summary from real findings',
  );

  return reviewResultsSchema.parse(existing);
};

// Runs the review questions using repository files only.
export const runReviewForJob = async (jobId: string, repoRoot: string): Promise<ReviewAnswer[]> => {
  const answers: ReviewAnswer[] = [];

  const run = async () => {
    const repoFiles = await scanRepoFiles(repoRoot);
    if (repoFiles.length === 0) {
      throw new Error('NO_READABLE_FILES');
    }
    logger.info(
      {
        jobId,
        stage: 'REVIEWING',
        fileCount: repoFiles.length,
        samplePaths: repoFiles.slice(0, 10).map((file) => file.path),
      },
      'Loaded real repository files for analysis',
    );

    for (const question of reviewQuestions) {
      try {
        logger.info(
          { jobId, stage: 'REVIEWING', questionId: question.id },
          'Starting question analysis',
        );
        const assessment =
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

        const refs = toRefs(assessment.findings);
        answers.push({
          id: question.id,
          title: question.title,
          category: question.category,
          severity: assessment.severity,
          answer: assessment.answer,
          refs,
        });
        logger.info(
          {
            jobId,
            stage: 'REVIEWING',
            questionId: question.id,
            severity: assessment.severity,
            findingCount: assessment.findings.length,
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
