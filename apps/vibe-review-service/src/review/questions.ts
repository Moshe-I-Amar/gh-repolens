export const reviewQuestions = [
  {
    id: 'security-sql-injection',
    title: 'Check for SQL injection in the code.',
    category: 'SECURITY',
    prompt: 'Inspect database queries and input handling for SQL injection risks.',
  },
  {
    id: 'security-xss',
    title: 'Check for cross-site scripting (XSS) risks.',
    category: 'SECURITY',
    prompt:
      'Review rendering paths, templating, and user-generated content handling for XSS risks and missing output encoding.',
  },
  {
    id: 'security-authz',
    title: 'Check authentication and authorization enforcement.',
    category: 'SECURITY',
    prompt:
      'Verify protected routes and sensitive actions enforce authentication and role-based access checks consistently.',
  },
  {
    id: 'security-secrets',
    title: 'Check for secrets exposure.',
    category: 'SECURITY',
    prompt:
      'Look for hardcoded credentials, tokens, or keys in code, configs, logs, and example env files.',
  },
  {
    id: 'security-dependency-vulns',
    title: 'Check for dependency vulnerabilities and unsafe packages.',
    category: 'SECURITY',
    prompt:
      'Review dependencies and lockfiles for known vulnerabilities or risky packages and recommend upgrades or removals.',
  },
  {
    id: 'code-review-summary',
    title: 'Code review summary of issues found during project scanning.',
    category: 'ARCH',
    prompt:
      'Summarize the key issues identified across the project scan and provide clear, actionable remediation guidance.',
  },
] as const;
