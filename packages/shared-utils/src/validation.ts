const githubRepoRegex = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\.git)?\/?$/;

export const isValidGithubRepoUrl = (value: string): boolean => {
  if (!value) {
    return false;
  }

  return githubRepoRegex.test(value.trim());
};
