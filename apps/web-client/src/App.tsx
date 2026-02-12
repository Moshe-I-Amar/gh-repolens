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

const fetchJobsByStatus = async (status: JobStatus) => {
  const response = await fetch(`${API_BASE_URL}/jobs?status=${encodeURIComponent(status)}`);
  if (!response.ok) {
    throw new Error(`Failed to load jobs for status ${status}`);
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

    const fetchJobs = async () => {
      try {
        const [queued, fetching, fetched, reviewing, completed, failed] = await Promise.all([
          fetchJobsByStatus('QUEUED'),
          fetchJobsByStatus('FETCHING'),
          fetchJobsByStatus('FETCHED'),
          fetchJobsByStatus('REVIEWING'),
          fetchJobsByStatus('COMPLETED'),
          fetchJobsByStatus('FAILED'),
        ]);
        if (active) {
          setInProgressJobs(sortByUpdatedAtDesc([...queued, ...fetching, ...fetched, ...reviewing]));
          setCompletedJobs(sortByUpdatedAtDesc(completed));
          setFailedJobs(sortByUpdatedAtDesc(failed));
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Unknown error');
          setLoading(false);
        }
      }

      timer = window.setTimeout(fetchJobs, 2500);
    };

    void fetchJobs();

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

    const fetchJob = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}`);
        if (!response.ok) {
          throw new Error('Failed to load job details');
        }
        const payload = (await response.json()) as Job;
        if (active) {
          setJob(payload);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Unknown error');
          setLoading(false);
        }
      }

      timer = window.setTimeout(fetchJob, 2500);
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

  const exportReportAsPdf = () => {
    if (!selectedJob || !selectedJob.reviewResults || selectedJob.status !== 'COMPLETED') {
      return;
    }

    const riskMarkup = selectedJob.reviewResults.riskSummary
      ? `<div class="block"><strong>Risk Summary</strong><p>Level: ${escapeHtml(
          selectedJob.reviewResults.riskSummary.level,
        )} | Score: ${selectedJob.reviewResults.riskSummary.score}/100</p><p>CRITICAL: ${
          selectedJob.reviewResults.riskSummary.counts.CRITICAL
        }, HIGH: ${selectedJob.reviewResults.riskSummary.counts.HIGH}, MEDIUM: ${
          selectedJob.reviewResults.riskSummary.counts.MEDIUM
        }, LOW: ${selectedJob.reviewResults.riskSummary.counts.LOW}, INFO: ${
          selectedJob.reviewResults.riskSummary.counts.INFO
        }, UNKNOWN: ${selectedJob.reviewResults.riskSummary.counts.UNKNOWN}</p></div>`
      : '';

    const questionMarkup = selectedJob.reviewResults.questions
      .map((question, questionIndex) => {
        const refs = question.refs.length
          ? `<ul>${question.refs
              .map((ref) => `<li>${escapeHtml(formatRef(ref))}</li>`)
              .join('')}</ul>`
          : '<p>No references.</p>';
        const findings = (question.findings ?? []).length
          ? `<ul>${(question.findings ?? [])
              .map(
                (finding) =>
                  `<li><strong>${escapeHtml(finding.path)}:${finding.line}${
                    finding.endLine ? `-${finding.endLine}` : ''
                  }</strong> - ${escapeHtml(finding.reason)}<br/>${escapeHtml(
                    finding.details,
                  )}<br/><em>Recommendation:</em> ${escapeHtml(finding.recommendation)}</li>`,
              )
              .join('')}</ul>`
          : '<p>No findings.</p>';
        return `<section class="question">
          <h3>${questionIndex + 1}. ${escapeHtml(question.title)}</h3>
          <p><strong>Category:</strong> ${escapeHtml(question.category)} | <strong>Severity:</strong> ${escapeHtml(
            question.severity,
          )}</p>
          <p>${escapeHtml(question.answer)}</p>
          <div class="block"><strong>References</strong>${refs}</div>
          <div class="block"><strong>Findings</strong>${findings}</div>
        </section>`;
      })
      .join('');

    const content = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>RepoLens Review Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #1b1b1f; line-height: 1.4; }
    h1 { margin: 0 0 4px; font-size: 22px; }
    h2 { margin: 18px 0 8px; font-size: 18px; }
    h3 { margin: 10px 0 6px; font-size: 15px; }
    p { margin: 6px 0; white-space: pre-wrap; }
    ul { margin: 6px 0 6px 18px; padding: 0; }
    li { margin: 4px 0; }
    .meta { margin-top: 10px; font-size: 13px; color: #333; }
    .block { border: 1px solid #d6cfc2; border-radius: 8px; padding: 10px; margin: 8px 0; }
    .question { border-top: 1px solid #ddd; padding-top: 10px; margin-top: 10px; page-break-inside: avoid; }
  </style>
</head>
<body>
  <h1>RepoLens Review Report</h1>
  <div class="meta">
    <p><strong>Repository:</strong> ${escapeHtml(selectedJob.repoUrl)}</p>
    <p><strong>Job ID:</strong> ${escapeHtml(selectedJob._id)}</p>
    <p><strong>Status:</strong> ${escapeHtml(statusLabel(selectedJob.status))}</p>
    <p><strong>Created:</strong> ${escapeHtml(formatDate(selectedJob.createdAt))}</p>
    <p><strong>Updated:</strong> ${escapeHtml(formatDate(selectedJob.updatedAt))}</p>
    <p><strong>Review Engine:</strong> ${escapeHtml(
      reviewEngineLabel(selectedJob.reviewResults.reviewEngine),
    )}</p>
  </div>
  ${riskMarkup}
  <h2>Questions (${selectedJob.reviewResults.questions.length})</h2>
  ${questionMarkup}
</body>
</html>`;

    const printWindow = window.open('', '_blank', 'noopener,noreferrer');
    if (!printWindow) {
      setFormError('Popup blocked. Allow popups to export PDF.');
      return;
    }

    printWindow.document.open();
    printWindow.document.write(content);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
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
                      onClick={exportReportAsPdf}
                      disabled={!canExportReport}
                      title={
                        canExportReport
                          ? 'Export review report as PDF'
                          : 'Available after review is completed'
                      }
                    >
                      Export PDF Report
                    </button>
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
