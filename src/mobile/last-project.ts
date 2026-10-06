// The project this phone last worked in: a fresh launch opens an empty chat there.
const KEY = "pigna:mobile-last-project";

export function lastProject(): string | undefined {
  try {
    return localStorage.getItem(KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function rememberProject(cwd: string): void {
  try {
    localStorage.setItem(KEY, cwd);
  } catch {
    // Private mode: the next launch opens the projects list.
  }
}
