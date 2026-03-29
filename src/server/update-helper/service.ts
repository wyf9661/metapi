import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { UpdateCenterVersionSource } from '../services/updateCenterVersionService.js';

type RunCommandInput = {
  command: string;
  args: string[];
  onLine?: (line: string) => void;
};

type RunCommandResult = {
  stdout: string;
};

type RunCommand = (input: RunCommandInput) => Promise<RunCommandResult>;

export type UpdateHelperDeployInput = {
  namespace: string;
  releaseName: string;
  chartRef: string;
  imageRepository: string;
  targetSource: UpdateCenterVersionSource;
  targetTag: string;
};

export type UpdateHelperStatusInput = {
  namespace: string;
  releaseName: string;
};

export type UpdateHelperDeploySummary = {
  success: boolean;
  targetSource: UpdateCenterVersionSource;
  targetTag: string;
  previousRevision: string | null;
  finalRevision: string | null;
  rolledBack: boolean;
  logLines: string[];
};

export type UpdateHelperStatus = {
  ok: boolean;
  releaseName: string;
  namespace: string;
  revision: string | null;
  imageRepository: string | null;
  imageTag: string | null;
  healthy: boolean;
};

async function runCommand(input: RunCommandInput): Promise<RunCommandResult> {
  return await new Promise<RunCommandResult>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const handleLine = (line: string) => {
      const normalized = line.trim();
      if (!normalized) return;
      input.onLine?.(normalized);
    };

    if (child.stdout) {
      const stdoutReader = createInterface({ input: child.stdout });
      stdoutReader.on('line', (line) => {
        stdout += `${line}\n`;
        handleLine(line);
      });
    }

    if (child.stderr) {
      const stderrReader = createInterface({ input: child.stderr });
      stderrReader.on('line', (line) => {
        stderr += `${line}\n`;
        handleLine(line);
      });
    }

    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim() });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${input.command} exited with code ${code}`));
    });
  });
}

function parseLatestRevision(stdout: string): string | null {
  try {
    const rows = JSON.parse(stdout) as Array<{ revision?: string | number }>;
    const last = Array.isArray(rows) && rows.length > 0 ? rows[rows.length - 1] : null;
    if (!last?.revision) return null;
    return String(last.revision);
  } catch {
    return null;
  }
}

function parseStatusRevision(stdout: string): string | null {
  try {
    const payload = JSON.parse(stdout) as { version?: string | number };
    if (payload?.version === undefined || payload?.version === null) return null;
    return String(payload.version);
  } catch {
    return null;
  }
}

export async function executeUpdateHelperDeploy(
  input: UpdateHelperDeployInput,
  deps: {
    runCommand?: RunCommand;
  } = {},
  onLog?: (line: string) => void,
): Promise<UpdateHelperDeploySummary> {
  const commandRunner = deps.runCommand || runCommand;
  const logLines: string[] = [];
  const captureLine = (line: string) => {
    logLines.push(line);
    onLog?.(line);
  };

  const history = await commandRunner({
    command: 'helm',
    args: ['history', input.releaseName, '-n', input.namespace, '-o', 'json'],
  });
  const previousRevision = parseLatestRevision(history.stdout);

  await commandRunner({
    command: 'helm',
    args: [
      'upgrade',
      input.releaseName,
      input.chartRef,
      '--namespace',
      input.namespace,
      '--reuse-values',
      '--set',
      `image.repository=${input.imageRepository}`,
      '--set',
      `image.tag=${input.targetTag}`,
    ],
    onLine: captureLine,
  });

  try {
    await commandRunner({
      command: 'kubectl',
      args: [
        'rollout',
        'status',
        'deployment',
        '-n',
        input.namespace,
        '-l',
        `app.kubernetes.io/instance=${input.releaseName}`,
        '--timeout=300s',
      ],
      onLine: captureLine,
    });
  } catch (error) {
    if (previousRevision) {
      await commandRunner({
        command: 'helm',
        args: ['rollback', input.releaseName, previousRevision, '-n', input.namespace],
        onLine: captureLine,
      });
    }
    throw error;
  }

  const status = await commandRunner({
    command: 'helm',
    args: ['status', input.releaseName, '-n', input.namespace, '-o', 'json'],
  });

  return {
    success: true,
    targetSource: input.targetSource,
    targetTag: input.targetTag,
    previousRevision,
    finalRevision: parseStatusRevision(status.stdout),
    rolledBack: false,
    logLines,
  };
}

export async function getUpdateHelperStatus(
  input: UpdateHelperStatusInput,
  deps: {
    runCommand?: RunCommand;
  } = {},
): Promise<UpdateHelperStatus> {
  const commandRunner = deps.runCommand || runCommand;
  const status = await commandRunner({
    command: 'helm',
    args: ['status', input.releaseName, '-n', input.namespace, '-o', 'json'],
  });
  const values = await commandRunner({
    command: 'helm',
    args: ['get', 'values', input.releaseName, '-n', input.namespace, '--all', '-o', 'json'],
  });

  const statusPayload = JSON.parse(status.stdout || '{}') as {
    version?: string | number;
    info?: {
      status?: string;
    };
  };
  const valuesPayload = JSON.parse(values.stdout || '{}') as {
    image?: {
      repository?: string;
      tag?: string;
    };
  };

  return {
    ok: true,
    releaseName: input.releaseName,
    namespace: input.namespace,
    revision: statusPayload.version === undefined || statusPayload.version === null ? null : String(statusPayload.version),
    imageRepository: valuesPayload.image?.repository || null,
    imageTag: valuesPayload.image?.tag || null,
    healthy: String(statusPayload.info?.status || '').toLowerCase() === 'deployed',
  };
}
