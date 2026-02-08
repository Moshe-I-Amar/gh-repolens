export const reviewQuestions = [
  {
    id: 'arch-boundaries',
    title: 'Are service boundaries and modules clearly defined?',
    category: 'ARCH',
    prompt: 'Review the repo for architectural boundaries, module ownership, and separation of concerns.',
  },
  {
    id: 'arch-deps',
    title: 'Are dependencies appropriate and minimal?',
    category: 'ARCH',
    prompt: 'Review external dependencies and highlight risky or unnecessary ones.',
  },
  {
    id: 'arch-config',
    title: 'Is configuration centralized and environment-driven?',
    category: 'ARCH',
    prompt: 'Check how configuration is loaded and if environment variables are used consistently.',
  },
  {
    id: 'security-input',
    title: 'Are inputs validated and sanitized?',
    category: 'SECURITY',
    prompt: 'Look for validation, parsing, and sanitization of external inputs.',
  },
  {
    id: 'security-secrets',
    title: 'Are secrets handled safely?',
    category: 'SECURITY',
    prompt: 'Inspect for secret leakage or unsafe logging of sensitive data.',
  },
  {
    id: 'security-auth',
    title: 'Are auth boundaries explicit and safe?',
    category: 'SECURITY',
    prompt: 'Check for authentication/authorization logic and risk of missing checks.',
  },
  {
    id: 'performance-io',
    title: 'Are IO-heavy paths efficient?',
    category: 'PERFORMANCE',
    prompt: 'Review file/DB/network operations and flag any blocking or wasteful patterns.',
  },
  {
    id: 'performance-caching',
    title: 'Are caching opportunities identified?',
    category: 'PERFORMANCE',
    prompt: 'Look for repeated operations that could be cached or memoized.',
  },
  {
    id: 'performance-scalability',
    title: 'Does the system scale with workload?',
    category: 'PERFORMANCE',
    prompt: 'Check for concurrency limits, queue settings, and scaling readiness.',
  },
  {
    id: 'observability',
    title: 'Are logging and error paths reliable?',
    category: 'ARCH',
    prompt: 'Review logging, error handling, and observability signals.',
  },
] as const;
