# Browser Tests

This directory contains Playwright browser tests for FeedBack keyboard shortcuts.

## Prerequisites

1. **FeedBack web server**: Tests need the server reachable at `http://localhost:8000`.
   Playwright auto-starts it via `webServer.command` in `playwright.config.ts`, so manual
   startup is optional. Start it manually if you want to debug the server, run tests
   outside Playwright, or skip the per-run boot delay:
   ```bash
   LIBRARY_PATH=/path/to/your/library docker compose up -d
   ```
   Playwright reuses an already-running server locally (`reuseExistingServer: true`).

2. **Node.js installed**: Required for running Playwright tests
   ```bash
   node --version  # Should be v18 or higher
   ```

## Installation

Install dependencies:
```bash
npm install
```

Install Playwright browsers:
```bash
npm run install:playwright
```

## Running Tests

Run all tests:
```bash
npm test
```

Run tests in headed mode (watch the browser):
```bash
npm run test:headed
```

Debug tests with interactive inspector:
```bash
npm run test:debug
```

## Test Files

- `basic-load.spec.ts` - Basic app load and shortcut registry availability
- `check-errors.spec.ts` - Check for console errors
- `keyboard-shortcuts.spec.ts` - Comprehensive keyboard shortcut tests

## Writing Tests

Tests use Playwright's test API. Example:

```typescript
import { test, expect } from '@playwright/test';

test('my test', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.screen.active');
  
  // Interact with the page
  await page.keyboard.press('?');
  
  // Assert
  await expect(page.locator('#shortcuts-modal')).toBeVisible();
});
```

## Troubleshooting

### Container won't start
If the Docker container exits immediately, check the logs:
```bash
docker compose logs
```

Common issue: Missing dependencies. Rebuild the container:
```bash
docker compose build --no-cache
docker compose up -d
```

### Tests timeout
Increase timeout in `playwright.config.ts` if needed.

### LIBRARY_PATH not set
Make sure to set the LIBRARY_PATH environment variable:
```bash
LIBRARY_PATH=~/feedBack-library docker compose up -d
```

## CI/CD

In CI environments, Playwright will:
- Run tests in headless mode
- Retry failed tests up to 2 times
- Generate HTML report with screenshots/videos on failure
