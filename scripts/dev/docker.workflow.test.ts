import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('docker workflows', () => {
  it('publishes armv7 docker images in ci and release workflows', () => {
    const ciWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    const releaseWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');

    expect(ciWorkflow).toContain('arch: armv7');
    expect(ciWorkflow).toContain('platform: linux/arm/v7');
    expect(ciWorkflow).toContain('"${tag}-armv7"');

    expect(releaseWorkflow).toContain('arch: armv7');
    expect(releaseWorkflow).toContain('platform: linux/arm/v7');
    expect(releaseWorkflow).toContain('"${tag}-armv7"');
  });

  it('smoke builds the armv7 docker image on pull requests', () => {
    const ciWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

    expect(ciWorkflow).toContain('Docker Smoke Build (armv7)');
    expect(ciWorkflow).toContain('if: github.event_name == \'pull_request\'');
    expect(ciWorkflow).toContain('platforms: linux/arm/v7');
    expect(ciWorkflow).toContain('push: false');
  });
});
