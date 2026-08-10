import { describe, expect, it } from 'vitest';

import { buildUpdateReminder } from './updateCenterPresentation.js';

describe('updateCenterPresentation', () => {
  it('returns an unknown reminder when no candidate source data is available', () => {
    expect(buildUpdateReminder({
      currentVersion: '1.2.3',
      helper: null,
      githubRelease: null,
      dockerHubTag: null,
    })).toEqual({
      label: '无法检查更新',
      badgeClassName: 'badge badge-muted',
      detail: '暂未获取到可比较的版本信息。',
      highlight: false,
    });
  });

  it('does not advertise an older GitHub reminder when the helper is already ahead', () => {
    expect(buildUpdateReminder({
      currentVersion: '1.2.3',
      helper: {
        imageTag: '1.4.0',
      },
      githubRelease: {
        normalizedVersion: '1.3.0',
        displayVersion: '1.3.0',
        tagName: 'v1.3.0',
      },
      dockerHubTag: null,
    })).toEqual({
      label: '已是最新',
      badgeClassName: 'badge badge-muted',
      detail: '当前运行版本与已发现的部署目标没有明显差异。',
      highlight: false,
    });
  });
});
