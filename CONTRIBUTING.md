# Contributing to Superagent

Thank you for your interest in contributing to Superagent! We welcome bug reports, feature requests, and code contributions from the community.

Please follow these guidelines to make the contribution process smooth and effective.

---

## Code of Conduct

We expect all contributors to adhere to respectful, collaborative, and professional communication standards at all times.

---

## How to Contribute

### 1. Reporting Bugs & Requesting Features
- Search existing issues to verify your bug or request hasn't been reported yet.
- Open a new issue with a clear description, reproduction steps (for bugs), and expected behavior.

### 2. Developing Code Changes
- Fork the repository and create your branch from the `main` branch.
- Use descriptive branch names:
  - `feat/some-new-feature`
  - `fix/description-of-bug`
  - `docs/update-guidelines`
- Follow our coding guidelines and verify that your code builds before committing.

### 3. Submission Process (Pull Requests)
- Open a Pull Request (PR) against the `main` branch.
- Write a clear PR title and description listing the changes made and referencing any associated issues.
- Ensure all tests pass (if any) and that your changes do not break CLI functionality.

---

## Coding Guidelines

- **TypeScript**: The codebase is written in TypeScript. Maintain strong typing and avoid `any` where possible.
- **Code Style**: We follow standard TypeScript and ESLint standards. 
- **OS Compatibility**: Ensure your code remains compatible across Windows, macOS, and Linux. When implementing shell commands, handle the OS context gracefully.
- **Terminal UI**: Components should respect Ink rendering constraints. Keep console rendering clean and avoid excessive redraws or visual flashes.
- **Planning Mode**: For significant architecture changes, document your proposed modifications via `implementation_plan.md` before coding.

---

## Commit Message Guidelines

We follow the Conventional Commits specification:

- `feat:` for new user-facing features.
- `fix:` for bug fixes.
- `docs:` for documentation updates.
- `style:` for code style adjustments (white space, formatting, etc.).
- `refactor:` for code changes that neither fix a bug nor add a feature.
- `test:` for adding or updating tests.
- `chore:` for building tasks, tool changes, or dependencies.

Example:
```
feat: add cyber/cyberpunk styling to terminal UI
```

---

## Getting Help

If you have questions about the codebase or the contribution process, feel free to open an issue or start a discussion. Happy coding!
