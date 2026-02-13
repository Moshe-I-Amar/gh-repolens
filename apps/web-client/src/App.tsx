import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { useEffect, useMemo, useState } from 'react';

type JobStatus =
  | 'QUEUED'
  | 'FETCHING'
  | 'FETCHED'
  | 'REVIEWING'
  | 'COMPLETED'
  | 'FAILED';

type ReviewRef = {
  path: string;
  line?: number;
  endLine?: number;
};

type ReviewFinding = {
  path: string;
  line: number;
  endLine?: number;
  reason: string;
  details: string;
  recommendation: string;
  codeSnippet: string;
};

type ReviewAnswer = {
  id: string;
  title: string;
  category: string;
  severity: string;
  answer: string;
  refs: ReviewRef[];
  findings?: ReviewFinding[];
};

type RiskSummary = {
  level: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  score: number;
  counts: Record<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO' | 'UNKNOWN', number>;
};

type ReviewResults = {
  questions: ReviewAnswer[];
  riskSummary?: RiskSummary;
  reviewEngine?: 'OPENAI' | 'RULES';
};

type Job = {
  _id: string;
  repoUrl: string;
  status: JobStatus;
  updatedAt: string;
  createdAt: string;
  localPath?: string | null;
  error?: string | null;
  reviewResults?: ReviewResults | null;
};

type ServiceHealth = {
  key: 'intake' | 'fetcher' | 'reviewer';
  label: string;
  url: string;
  ok: boolean;
  message: string;
  service?: string;
  uptimeSec?: number;
};

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001';
const INTAKE_HEALTH_URL = import.meta.env.VITE_INTAKE_HEALTH_URL ?? `${API_BASE_URL}/health`;
const FETCHER_HEALTH_URL =
  import.meta.env.VITE_FETCHER_HEALTH_URL ?? 'http://localhost:3002/health';
const REVIEWER_HEALTH_URL =
  import.meta.env.VITE_REVIEWER_HEALTH_URL ?? 'http://localhost:3003/health';

const forbiddenRepoFragments = ['example', 'sample', 'test', 'your-org', 'your-repo'];
const githubRepoRegex = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\.git)?\/?$/;
const inProgressStatuses: JobStatus[] = ['QUEUED', 'FETCHING', 'FETCHED', 'REVIEWING'];
const serviceDefinitions: Array<{
  key: ServiceHealth['key'];
  label: string;
  url: string;
}> = [
  { key: 'intake', label: 'Intake API', url: INTAKE_HEALTH_URL },
  { key: 'fetcher', label: 'Repo Fetcher', url: FETCHER_HEALTH_URL },
  { key: 'reviewer', label: 'Vibe Review', url: REVIEWER_HEALTH_URL },
];
const JOBS_POLL_BASE_MS = 5000;
const JOBS_POLL_MAX_BACKOFF_MS = 60000;
const DETAILS_POLL_BASE_MS = 6000;
const DETAILS_POLL_MAX_BACKOFF_MS = 60000;

const statusLabel = (status: JobStatus) =>
  status.toLowerCase().replace(/(^|\s|_)([a-z])/g, (_m, p1, p2) => `${p1}${p2.toUpperCase()}`);

const formatDate = (value: string) => new Date(value).toLocaleString();

const reviewEngineLabel = (engine?: 'OPENAI' | 'RULES') =>
  engine === 'OPENAI' ? 'OpenAI (Codex)' : engine === 'RULES' ? 'Local Rules' : 'Unknown';

const formatRef = (ref: ReviewRef) => {
  if (!ref.line) {
    return ref.path;
  }
  if (!ref.endLine || ref.endLine === ref.line) {
    return `${ref.path}:${ref.line}`;
  }
  return `${ref.path}:${ref.line}-${ref.endLine}`;
};

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const sortByUpdatedAtDesc = (jobs: Job[]) =>
  [...jobs].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

const validateRepoUrl = (value: string) => {
  const trimmed = value.trim();
  if (!githubRepoRegex.test(trimmed)) {
    return 'Use a valid GitHub repository URL.';
  }
  if (forbiddenRepoFragments.some((fragment) => trimmed.toLowerCase().includes(fragment))) {
    return 'Example or test repository URLs are rejected.';
  }
  return null;
};

const fetchJobs = async () => {
  const response = await fetch(`${API_BASE_URL}/jobs`);
  if (!response.ok) {
    const error = new Error('Failed to load jobs');
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return (await response.json()) as Job[];
};

const usePollingJobs = () => {
  const [inProgressJobs, setInProgressJobs] = useState<Job[]>([]);
  const [completedJobs, setCompletedJobs] = useState<Job[]>([]);
  const [failedJobs, setFailedJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let nextDelayMs = JOBS_POLL_BASE_MS;

    const runPoll = async () => {
      try {
        const jobs = await fetchJobs();
        const inProgress = jobs.filter((job) => inProgressStatuses.includes(job.status));
        const completed = jobs.filter((job) => job.status === 'COMPLETED');
        const failed = jobs.filter((job) => job.status === 'FAILED');
        if (active) {
          setInProgressJobs(sortByUpdatedAtDesc(inProgress));
          setCompletedJobs(sortByUpdatedAtDesc(completed));
          setFailedJobs(sortByUpdatedAtDesc(failed));
          setError(null);
          setLoading(false);
        }
        nextDelayMs = JOBS_POLL_BASE_MS;
      } catch (err) {
        const status = (err as Error & { status?: number }).status;
        if (active) {
          if (status === 429) {
            setError('Rate limited by intake service. Backing off polling automatically.');
          } else {
            setError(err instanceof Error ? err.message : 'Unknown error');
          }
          setLoading(false);
        }
        nextDelayMs =
          status === 429
            ? Math.min(nextDelayMs * 2, JOBS_POLL_MAX_BACKOFF_MS)
            : Math.min(Math.max(nextDelayMs, 10000), JOBS_POLL_MAX_BACKOFF_MS);
      }

      timer = window.setTimeout(runPoll, nextDelayMs);
    };

    void runPoll();

    return () => {
      active = false;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  return { inProgressJobs, completedJobs, failedJobs, error, loading };
};

const useJobDetails = (jobId: string | null) => {
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      setLoading(false);
      setError(null);
      return;
    }

    let active = true;
    let timer: number | undefined;
    let nextDelayMs = DETAILS_POLL_BASE_MS;

    const fetchJob = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}`);
        if (!response.ok) {
          const error = new Error('Failed to load job details');
          (error as Error & { status?: number }).status = response.status;
          throw error;
        }
        const payload = (await response.json()) as Job;
        if (active) {
          setJob(payload);
          setError(null);
          setLoading(false);
        }
        nextDelayMs = DETAILS_POLL_BASE_MS;
      } catch (err) {
        if (active) {
          const status = (err as Error & { status?: number }).status;
          if (status === 429) {
            setError('Rate limited while loading job details. Retrying with backoff.');
          } else {
            setError(err instanceof Error ? err.message : 'Unknown error');
          }
          setLoading(false);
        }
        const status = (err as Error & { status?: number }).status;
        nextDelayMs =
          status === 429
            ? Math.min(nextDelayMs * 2, DETAILS_POLL_MAX_BACKOFF_MS)
            : Math.min(Math.max(nextDelayMs, 12000), DETAILS_POLL_MAX_BACKOFF_MS);
      }

      timer = window.setTimeout(fetchJob, nextDelayMs);
    };

    setLoading(true);
    void fetchJob();

    return () => {
      active = false;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [jobId]);

  return { job, loading, error };
};

const useServiceHealth = () => {
  const [services, setServices] = useState<ServiceHealth[]>(
    serviceDefinitions.map((service) => ({
      ...service,
      ok: false,
      message: 'Checking...',
    })),
  );

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    const check = async () => {
      const next = await Promise.all(
        serviceDefinitions.map(async (service) => {
          try {
            const response = await fetch(service.url);
            if (!response.ok) {
              throw new Error(`HTTP_${response.status}`);
            }
            const data = (await response.json()) as {
              status?: string;
              service?: string;
              uptimeSec?: number;
            };
            return {
              ...service,
              ok: data.status === 'ok',
              message: data.status === 'ok' ? 'Online' : 'Unhealthy',
              service: data.service,
              uptimeSec: data.uptimeSec,
            };
          } catch (_err) {
            return {
              ...service,
              ok: false,
              message: 'Offline',
              service: undefined,
              uptimeSec: undefined,
            };
          }
        }),
      );

      if (active) {
        setServices(next);
      }
      timer = window.setTimeout(check, 5000);
    };

    void check();

    return () => {
      active = false;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  return services;
};

export default function App() {
  const { inProgressJobs, completedJobs, failedJobs, error, loading } = usePollingJobs();
  const health = useServiceHealth();
  const [repoUrl, setRepoUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportDownload, setExportDownload] = useState<{ url: string; filename: string } | null>(
    null,
  );
  const [exportDebug, setExportDebug] = useState<string[]>([]);
  const [inProgressPage, setInProgressPage] = useState(1);
  const [completedPage, setCompletedPage] = useState(1);
  const [failedPage, setFailedPage] = useState(1);
  const { job: selectedJob, loading: detailLoading, error: detailError } = useJobDetails(selectedJobId);
  const pageSize = 7;

  const inProgressPages = Math.max(1, Math.ceil(inProgressJobs.length / pageSize));
  const completedPages = Math.max(1, Math.ceil(completedJobs.length / pageSize));
  const failedPages = Math.max(1, Math.ceil(failedJobs.length / pageSize));
  const inProgressSlice = useMemo(
    () => inProgressJobs.slice((inProgressPage - 1) * pageSize, inProgressPage * pageSize),
    [inProgressJobs, inProgressPage],
  );
  const completedSlice = useMemo(
    () => completedJobs.slice((completedPage - 1) * pageSize, completedPage * pageSize),
    [completedJobs, completedPage],
  );
  const failedSlice = useMemo(
    () => failedJobs.slice((failedPage - 1) * pageSize, failedPage * pageSize),
    [failedJobs, failedPage],
  );

  useEffect(() => {
    if (inProgressPage > inProgressPages) {
      setInProgressPage(inProgressPages);
    }
  }, [inProgressPage, inProgressPages]);

  useEffect(() => {
    if (completedPage > completedPages) {
      setCompletedPage(completedPages);
    }
  }, [completedPage, completedPages]);

  useEffect(() => {
    if (failedPage > failedPages) {
      setFailedPage(failedPages);
    }
  }, [failedPage, failedPages]);

  useEffect(() => {
    // Revoke the previous blob URL when a new one is generated (or when unmounting).
    return () => {
      if (exportDownload?.url) {
        URL.revokeObjectURL(exportDownload.url);
      }
    };
  }, [exportDownload?.url]);

  const pushExportDebug = (message: string) => {
    const stamp = new Date().toISOString();
    setExportDebug((prev) => [`${stamp} ${message}`, ...prev].slice(0, 30));
  };

  const submitJob = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    const validationError = validateRepoUrl(repoUrl);
    if (validationError) {
      setSubmitting(false);
      setFormError(validationError);
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: repoUrl.trim() }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? 'Failed to submit repo');
      }

      setRepoUrl('');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleAnswer = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const isKnownInProgress = selectedJob ? inProgressStatuses.includes(selectedJob.status) : false;
  const canExportReport = Boolean(
    selectedJob &&
      selectedJob.status === 'COMPLETED' &&
      selectedJob.reviewResults &&
      selectedJob.reviewResults.questions.length > 0,
  );

  const exportReportAsPdf = async () => {
    if (!selectedJob || !selectedJob.reviewResults || selectedJob.status !== 'COMPLETED') {
      pushExportDebug('export aborted: no completed job selected');
      return;
    }

    setFormError(null);
    setExportDownload(null);
    setIsExporting(true);
    pushExportDebug(
      `export start: jobId=${selectedJob._id} questions=${selectedJob.reviewResults.questions.length}`,
    );
    console.groupCollapsed(`[Export PDF] ${selectedJob._id}`);
    console.debug('start', {
      jobId: selectedJob._id,
      status: selectedJob.status,
      questionCount: selectedJob.reviewResults.questions.length,
    });

    const truncate = (value: string, maxLen: number) =>
      value.length > maxLen ? `${value.slice(0, Math.max(0, maxLen - 1))}…` : value;

    try {
      const pdfDoc = await PDFDocument.create();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      const pageWidth = 595.28; // A4 portrait
      const pageHeight = 841.89;
      const margin = 48;
      const bodyFontSize = 11;
      const bodyLineHeight = 14;
      const maxWidth = pageWidth - margin * 2;

      let page = pdfDoc.addPage([pageWidth, pageHeight]);
      let cursorY = pageHeight - margin;

      const newPage = () => {
        page = pdfDoc.addPage([pageWidth, pageHeight]);
        cursorY = pageHeight - margin;
      };

      const ensureSpace = (neededHeight: number) => {
        if (cursorY - neededHeight < margin) {
          newPage();
        }
      };

      const wrapText = (value: string, width: number, usedFont: typeof font, fontSize: number) => {
        const lines: string[] = [];
        for (const paragraph of value.split(/\r?\n/)) {
          const trimmed = paragraph.trimEnd();
          if (trimmed.length === 0) {
            lines.push('');
            continue;
          }
          const words = trimmed.split(/\s+/);
          let line = '';
          for (const word of words) {
            const candidate = line ? `${line} ${word}` : word;
            if (usedFont.widthOfTextAtSize(candidate, fontSize) <= width) {
              line = candidate;
              continue;
            }
            if (line) {
              lines.push(line);
            }
            line = word;
          }
          if (line) {
            lines.push(line);
          }
        }
        return lines;
      };

      const drawWrapped = (value: string, opts?: { bold?: boolean; indent?: number; size?: number }) => {
        const size = opts?.size ?? bodyFontSize;
        const usedFont = opts?.bold ? fontBold : font;
        const indent = opts?.indent ?? 0;
        const availableWidth = maxWidth - indent;

        for (const line of wrapText(value, availableWidth, usedFont, size)) {
          ensureSpace(bodyLineHeight);
          page.drawText(line, {
            x: margin + indent,
            y: cursorY - size,
            size,
            font: usedFont,
            color: rgb(0, 0, 0),
          });
          cursorY -= bodyLineHeight;
        }
      };

      const drawSpacer = (height = bodyLineHeight) => {
        ensureSpace(height);
        cursorY -= height;
      };

      drawWrapped('RepoLens Review Report', { bold: true, size: 18 });
      drawWrapped(`Repository: ${selectedJob.repoUrl}`);
      drawWrapped(`Job ID: ${selectedJob._id}`);
      drawWrapped(`Status: ${statusLabel(selectedJob.status)}`);
      drawWrapped(`Created: ${formatDate(selectedJob.createdAt)}`);
      drawWrapped(`Updated: ${formatDate(selectedJob.updatedAt)}`);
      drawWrapped(`Review Engine: ${reviewEngineLabel(selectedJob.reviewResults.reviewEngine)}`);
      drawWrapped(`Generated: ${new Date().toLocaleString()}`);
      drawSpacer();

      if (selectedJob.reviewResults.riskSummary) {
        const risk = selectedJob.reviewResults.riskSummary;
        drawWrapped('Risk Summary', { bold: true, size: 14 });
        drawWrapped(`Level: ${risk.level} | Score: ${risk.score}/100`);
        drawWrapped(
          `CRITICAL: ${risk.counts.CRITICAL}, HIGH: ${risk.counts.HIGH}, MEDIUM: ${risk.counts.MEDIUM}, LOW: ${risk.counts.LOW}, INFO: ${risk.counts.INFO}, UNKNOWN: ${risk.counts.UNKNOWN}`,
        );
        drawSpacer();
      }

      drawWrapped(`Questions (${selectedJob.reviewResults.questions.length})`, { bold: true, size: 14 });
      drawSpacer(bodyLineHeight / 2);

      for (const [index, question] of selectedJob.reviewResults.questions.entries()) {
        drawWrapped(`${index + 1}. ${question.title}`, { bold: true });
        drawWrapped(`Category: ${question.category} | Severity: ${question.severity}`);
        drawSpacer(bodyLineHeight / 2);

        if (question.answer.trim().length > 0) {
          drawWrapped(question.answer);
          drawSpacer(bodyLineHeight / 2);
        }

        drawWrapped('References', { bold: true });
        if (question.refs.length === 0) {
          drawWrapped('No references.', { indent: 12 });
        } else {
          for (const ref of question.refs) {
            drawWrapped(`- ${formatRef(ref)}`, { indent: 12 });
          }
        }
        drawSpacer(bodyLineHeight / 2);

        drawWrapped('Findings', { bold: true });
        const findings = question.findings ?? [];
        if (findings.length === 0) {
          drawWrapped('No findings.', { indent: 12 });
        } else {
          for (const finding of findings) {
            const location = `${finding.path}:${finding.line}${finding.endLine ? `-${finding.endLine}` : ''}`;
            drawWrapped(`- ${location} - ${finding.reason}`, { indent: 12 });
            drawWrapped(`Details: ${truncate(finding.details, 1200)}`, { indent: 24 });
            drawWrapped(`Recommendation: ${truncate(finding.recommendation, 800)}`, { indent: 24 });
          }
        }

        drawSpacer();
      }

      const pdfBytes = await pdfDoc.save();
      // Ensure a DOM-friendly buffer type for Blob construction across TS lib variants.
      const pdfUint8 = new Uint8Array(pdfBytes);
      pushExportDebug(`pdf bytes: ${pdfUint8.byteLength}`);
      console.debug('pdf bytes', pdfUint8.byteLength);
      const blob = new Blob([pdfUint8], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      pushExportDebug(`blob url: ${url}`);
      console.debug('blob url', url);

      const safeId = selectedJob._id.replaceAll(/[^A-Za-z0-9_-]/g, '_');
      const filename = `repolens-report-${safeId}.pdf`;
      setExportDownload({ url, filename });
      pushExportDebug(`download filename: ${filename}`);

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      // Avoid inheriting any global/default target behavior that could open a new tab.
      a.target = '_self';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      pushExportDebug('triggering a.click()');
      console.debug('a.click()', { href: a.href, download: a.download, target: a.target });
      a.click();
      a.remove();
      pushExportDebug('a.click() done');
    } catch (err) {
      console.error('export failed', err);
      setFormError(err instanceof Error ? err.message : 'Failed to export PDF');
      pushExportDebug(`export failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setIsExporting(false);
      console.groupEnd();
    }
  };

  return (
    <div className="app">
      <header>
        <div className="header-left">
          <h1>RepoLens</h1>
          <p>Production pipeline view for intake, fetch, and AI/rule code review.</p>
        </div>
        <span className="badge">Backend Synced</span>
      </header>

      <section className="hero">
        <strong>Submit a repo URL</strong>
        <form onSubmit={submitJob}>
          <input
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            placeholder="https://github.com/org/repo"
          />
          <button type="submit" disabled={submitting || repoUrl.length === 0}>
            {submitting ? 'Submitting...' : 'Queue Review'}
          </button>
        </form>
        {formError && <p className="empty">{formError}</p>}
      </section>

      <section className="content">
        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          <h2>Service Health</h2>
          <div className="health-grid">
            {health.map((service) => (
              <div key={service.key} className={`health-card ${service.ok ? 'ok' : 'bad'}`}>
                <strong>{service.label}</strong>
                <span>{service.message}</span>
                {service.uptimeSec !== undefined && <span>Uptime {service.uptimeSec}s</span>}
                <code>{service.url}</code>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="content">
        <div className="panel">
          <h2>In Progress ({inProgressJobs.length})</h2>
          {loading && <p className="empty">Loading jobs...</p>}
          {error && <p className="empty">{error}</p>}
          <div className="jobs">
            {inProgressJobs.length === 0 && !loading ? (
              <p className="empty">No active scans yet.</p>
            ) : (
              inProgressSlice.map((job) => (
                <div
                  key={job._id}
                  className="job-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedJobId(job._id)}
                >
                  <strong>{job.repoUrl}</strong>
                  <span>{statusLabel(job.status)}</span>
                  <span>Updated {formatDate(job.updatedAt)}</span>
                </div>
              ))
            )}
          </div>
          {inProgressJobs.length > pageSize && (
            <div className="pagination">
              <button
                type="button"
                onClick={() => setInProgressPage((prev) => Math.max(1, prev - 1))}
                disabled={inProgressPage === 1}
              >
                Prev
              </button>
              <span>
                Page {inProgressPage} of {inProgressPages}
              </span>
              <button
                type="button"
                onClick={() => setInProgressPage((prev) => Math.min(inProgressPages, prev + 1))}
                disabled={inProgressPage === inProgressPages}
              >
                Next
              </button>
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Completed ({completedJobs.length})</h2>
          <div className="jobs">
            {completedJobs.length === 0 ? (
              <p className="empty">No completed reviews yet.</p>
            ) : (
              completedSlice.map((job) => (
                <div
                  key={job._id}
                  className="job-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedJobId(job._id)}
                >
                  <strong>{job.repoUrl}</strong>
                  <span>{statusLabel(job.status)}</span>
                  <span>Updated {formatDate(job.updatedAt)}</span>
                </div>
              ))
            )}
          </div>
          {completedJobs.length > pageSize && (
            <div className="pagination">
              <button
                type="button"
                onClick={() => setCompletedPage((prev) => Math.max(1, prev - 1))}
                disabled={completedPage === 1}
              >
                Prev
              </button>
              <span>
                Page {completedPage} of {completedPages}
              </span>
              <button
                type="button"
                onClick={() => setCompletedPage((prev) => Math.min(completedPages, prev + 1))}
                disabled={completedPage === completedPages}
              >
                Next
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="content">
        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          <h2>Failed ({failedJobs.length})</h2>
          <div className="jobs">
            {failedJobs.length === 0 ? (
              <p className="empty">No failed jobs.</p>
            ) : (
              failedSlice.map((job) => (
                <div
                  key={job._id}
                  className="job-card failed"
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedJobId(job._id)}
                >
                  <strong>{job.repoUrl}</strong>
                  <span>{statusLabel(job.status)}</span>
                  <span>Error: {job.error ?? 'UNKNOWN_FAILURE'}</span>
                  <span>Updated {formatDate(job.updatedAt)}</span>
                </div>
              ))
            )}
          </div>
          {failedJobs.length > pageSize && (
            <div className="pagination">
              <button
                type="button"
                onClick={() => setFailedPage((prev) => Math.max(1, prev - 1))}
                disabled={failedPage === 1}
              >
                Prev
              </button>
              <span>
                Page {failedPage} of {failedPages}
              </span>
              <button
                type="button"
                onClick={() => setFailedPage((prev) => Math.min(failedPages, prev + 1))}
                disabled={failedPage === failedPages}
              >
                Next
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="content">
        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          {selectedJobId ? (
            detailLoading && !selectedJob ? (
              <p className="empty">Loading job details...</p>
            ) : detailError ? (
              <p className="empty">{detailError}</p>
            ) : selectedJob ? (
              <>
                <div className="detail-header">
                  <div>
                    <h2>Review Details</h2>
                    <p className="empty">{selectedJob.repoUrl}</p>
                    <p className="empty">Status: {statusLabel(selectedJob.status)}</p>
                    <p className="empty">Created: {formatDate(selectedJob.createdAt)}</p>
                    <p className="empty">Updated: {formatDate(selectedJob.updatedAt)}</p>
                    <p className="empty">
                      Download folder:{' '}
                      {selectedJob.localPath ? selectedJob.localPath : 'Pending workspace assignment'}
                    </p>
                    <p className="empty">
                      Review engine: {reviewEngineLabel(selectedJob.reviewResults?.reviewEngine)}
                    </p>
                    {selectedJob.reviewResults?.riskSummary && (
                      <div className="risk-box">
                        <strong>
                          Risk: {selectedJob.reviewResults.riskSummary.level} (
                          {selectedJob.reviewResults.riskSummary.score}/100)
                        </strong>
                        <span>
                          C:{selectedJob.reviewResults.riskSummary.counts.CRITICAL} H:
                          {selectedJob.reviewResults.riskSummary.counts.HIGH} M:
                          {selectedJob.reviewResults.riskSummary.counts.MEDIUM} L:
                          {selectedJob.reviewResults.riskSummary.counts.LOW} I:
                          {selectedJob.reviewResults.riskSummary.counts.INFO}
                        </span>
                      </div>
                    )}
                    {selectedJob.error && <p className="error-text">Failure reason: {selectedJob.error}</p>}
                  </div>
                  <div className="detail-actions">
                    <button
                      type="button"
                      className="export-btn"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void exportReportAsPdf();
                      }}
                      disabled={!canExportReport || isExporting}
                      title={
                        canExportReport
                          ? 'Export review report as PDF'
                          : 'Available after review is completed'
                      }
                    >
                      {isExporting ? 'Generating PDF...' : 'Export PDF Report'}
                    </button>
                    {exportDownload && (
                      <a
                        className="export-link"
                        href={exportDownload.url}
                        download={exportDownload.filename}
                        target="_self"
                        rel="noopener noreferrer"
                      >
                        If download did not start, click to download
                      </a>
                    )}
                    {exportDebug.length > 0 && (
                      <details>
                        <summary>Export debug</summary>
                        <pre style={{ maxWidth: 480, whiteSpace: 'pre-wrap' }}>
                          {exportDebug.join('\n')}
                        </pre>
                      </details>
                    )}
                    <button type="button" onClick={() => setSelectedJobId(null)}>
                      Close
                    </button>
                  </div>
                </div>
                <div className="jobs">
                  {(selectedJob.reviewResults?.questions ?? []).map((question) => (
                    <div key={question.id} className="accordion">
                      <button type="button" onClick={() => toggleAnswer(question.id)}>
                        {question.title}
                      </button>
                      <div className="question-meta">
                        <span>{question.category}</span>
                        <span>Severity: {question.severity}</span>
                      </div>
                      {expanded[question.id] && (
                        <div className="answer">
                          <p>{question.answer}</p>
                          {question.refs.length > 0 && (
                            <>
                              <strong>References</strong>
                              <ul className="ref-list">
                                {question.refs.map((ref, index) => (
                                  <li key={`${question.id}-${ref.path}-${ref.line ?? 'na'}-${index}`}>
                                    {formatRef(ref)}
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                          {(question.findings ?? []).map((finding, index) => (
                            <div
                              key={`${question.id}-${finding.path}-${finding.line}-${index}`}
                              className="finding"
                            >
                              <div className="finding-title">
                                {finding.path}:{finding.line}
                                {finding.endLine ? `-${finding.endLine}` : ''} - {finding.reason}
                              </div>
                              <p className="finding-details">{finding.details}</p>
                              <p className="finding-fix">Recommendation: {finding.recommendation}</p>
                              <pre className="finding-code">{finding.codeSnippet}</pre>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {isKnownInProgress && <p className="empty">Review results will appear once completed.</p>}
                  {selectedJob.status === 'FAILED' && (
                    <p className="empty">
                      Job failed before full review completion. Error: {selectedJob.error ?? 'UNKNOWN_FAILURE'}
                    </p>
                  )}
                </div>
              </>
            ) : (
              <p className="empty">Job not found.</p>
            )
          ) : (
            <p className="empty">Select a job to view operational and review details.</p>
          )}
        </div>
      </section>
    </div>
  );
}
