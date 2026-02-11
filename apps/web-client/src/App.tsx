import { useEffect, useMemo, useState } from 'react';

type JobStatus =
  | 'QUEUED'
  | 'FETCHING'
  | 'FETCHED'
  | 'REVIEWING'
  | 'COMPLETED'
  | 'FAILED';

type ReviewAnswer = {
  findings?: Array<{
    path: string;
    line: number;
    reason: string;
    details: string;
    recommendation: string;
    codeSnippet: string;
  }>;
  id: string;
  title: string;
  category: string;
  severity: string;
  answer: string;
};

type Job = {
  _id: string;
  repoUrl: string;
  status: JobStatus;
  updatedAt: string;
  localPath?: string | null;
  reviewResults?: { questions: ReviewAnswer[] } | null;
};

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001';
const forbiddenRepoFragments = ['example', 'sample', 'test', 'your-org', 'your-repo'];
const githubRepoRegex = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\.git)?\/?$/;

const statusLabel = (status: JobStatus) =>
  status.toLowerCase().replace(/(^|\s|_)([a-z])/g, (_m, p1, p2) => `${p1}${p2.toUpperCase()}`);

const isInProgress = (status: JobStatus) =>
  ['QUEUED', 'FETCHING', 'FETCHED', 'REVIEWING'].includes(status);

const formatDate = (value: string) => new Date(value).toLocaleString();

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

const usePollingJobs = () => {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    const fetchJobs = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/jobs`);
        if (!response.ok) {
          throw new Error('Failed to load jobs');
        }
        const data = (await response.json()) as Job[];
        if (active) {
          setJobs(data);
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

    fetchJobs();

    return () => {
      active = false;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  return { jobs, error, loading };
};

export default function App() {
  const { jobs, error, loading } = usePollingJobs();
  const [repoUrl, setRepoUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [inProgressPage, setInProgressPage] = useState(1);
  const [completedPage, setCompletedPage] = useState(1);
  const pageSize = 7;

  const inProgress = useMemo(() => jobs.filter((job) => isInProgress(job.status)), [jobs]);
  const completed = useMemo(() => jobs.filter((job) => job.status === 'COMPLETED'), [jobs]);
  const inProgressPages = Math.max(1, Math.ceil(inProgress.length / pageSize));
  const completedPages = Math.max(1, Math.ceil(completed.length / pageSize));
  const inProgressSlice = useMemo(
    () => inProgress.slice((inProgressPage - 1) * pageSize, inProgressPage * pageSize),
    [inProgress, inProgressPage]
  );
  const completedSlice = useMemo(
    () => completed.slice((completedPage - 1) * pageSize, completedPage * pageSize),
    [completed, completedPage]
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
    if (!selectedJob) {
      return;
    }

    const refreshed = jobs.find((job) => job._id === selectedJob._id);
    if (refreshed) {
      setSelectedJob(refreshed);
    }
  }, [jobs, selectedJob]);

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

  return (
    <div className="app">
      <header>
        <div className="header-left">
          <h1>RepoLens</h1>
          <p>Ship GitHub repos through automated intake, fetch, and review.</p>
        </div>
        <span className="badge">Sprint 1</span>
      </header>

      <section className="hero">
        <strong>Submit a repo URL</strong>
        <form onSubmit={submitJob}>
          <input
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
          />
          <button type="submit" disabled={submitting || repoUrl.length === 0}>
            {submitting ? 'Submitting...' : 'Queue Review'}
          </button>
        </form>
        {formError && <p className="empty">{formError}</p>}
      </section>

      <section className="content">
        <div className="panel">
          <h2>In Progress</h2>
          {loading && <p className="empty">Loading jobs...</p>}
          {error && <p className="empty">{error}</p>}
          <div className="jobs">
            {inProgress.length === 0 && !loading ? (
              <p className="empty">No active scans yet.</p>
            ) : (
              inProgressSlice.map((job) => (
                <div
                  key={job._id}
                  className="job-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedJob(job)}
                >
                  <strong>{job.repoUrl}</strong>
                  <span>{statusLabel(job.status)}</span>
                  <span>Updated {formatDate(job.updatedAt)}</span>
                </div>
              ))
            )}
          </div>
          {inProgress.length > pageSize && (
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
          <h2>Completed</h2>
          <div className="jobs">
            {completed.length === 0 ? (
              <p className="empty">No completed reviews yet.</p>
            ) : (
              completedSlice.map((job) => (
                <div
                  key={job._id}
                  className="job-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedJob(job)}
                >
                  <strong>{job.repoUrl}</strong>
                  <span>{statusLabel(job.status)}</span>
                  <span>Updated {formatDate(job.updatedAt)}</span>
                </div>
              ))
            )}
          </div>
          {completed.length > pageSize && (
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
          {selectedJob ? (
            <>
              <div className="detail-header">
                <div>
                  <h2>Review Details</h2>
                  <p className="empty">{selectedJob.repoUrl}</p>
                  <p className="empty">
                    Download folder:{' '}
                    {selectedJob.localPath ? selectedJob.localPath : 'Pending workspace assignment'}
                  </p>
                </div>
                <button type="button" onClick={() => setSelectedJob(null)}>
                  Close
                </button>
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
                        {(question.findings ?? []).map((finding, index) => (
                          <div key={`${question.id}-${finding.path}-${finding.line}-${index}`} className="finding">
                            <div className="finding-title">
                              {finding.path}:{finding.line} - {finding.reason}
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
                {selectedJob.status !== 'COMPLETED' && (
                  <p className="empty">Review results will appear once completed.</p>
                )}
              </div>
            </>
          ) : (
            <p className="empty">Select a job to view its review answers.</p>
          )}
        </div>
      </section>
    </div>
  );
}
