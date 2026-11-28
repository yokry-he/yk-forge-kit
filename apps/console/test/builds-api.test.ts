import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Build, BuildLogEvent, BuildStreamTicket } from '@forgekit/contracts';
import {
  buildLogStreamUrl,
  cancelBuild,
  createBuildStreamTicket,
  getBuild,
  listBuilds,
  listBuildLogs,
  triggerBuild,
} from '../src/api/builds';
import { projectRequest } from '../src/api/projects';

vi.mock('../src/api/projects', () => ({
  projectRequest: vi.fn(),
}));

const mockProjectRequest = vi.mocked(projectRequest);

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const BUILD_ID = '22222222-2222-4222-8222-222222222222';

const build: Build = {
  id: BUILD_ID,
  projectId: PROJECT_ID,
  number: 1,
  template: 'vue',
  sourceRef: 'main',
  status: 'queued',
  triggeredBy: '33333333-3333-4333-8333-333333333333',
  queuedAt: '2026-11-19T01:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-11-19T01:00:00.000Z',
  updatedAt: '2026-11-19T01:00:00.000Z',
  exitCode: null,
  errorMessage: null,
  artifactKey: null,
  artifactSize: null,
  artifactSha256: null,
  logStorageKey: null,
  runnerInfo: null, diagnosis: null,
};

const logEvent: BuildLogEvent = {
  buildId: BUILD_ID,
  seq: 1,
  stream: 'stdout',
  content: 'hello\n',
  ts: '2026-11-19T01:02:03.000Z',
};

const ticket: BuildStreamTicket = {
  ticket: 'a'.repeat(43),
  expiresAt: '2026-11-19T01:05:00.000Z',
};

beforeEach(() => {
  mockProjectRequest.mockReset();
});

describe('builds API client', () => {
  describe('listBuilds', () => {
    it('requests the project build list with no query when no options', async () => {
      mockProjectRequest.mockResolvedValue([build]);
      const result = await listBuilds(PROJECT_ID);
      expect(mockProjectRequest).toHaveBeenCalledTimes(1);
      const [path, init] = mockProjectRequest.mock.calls[0]!;
      expect(path).toBe(`/${encodeURIComponent(PROJECT_ID)}/builds`);
      expect(init).toBeUndefined();
      expect(result).toEqual([build]);
    });

    it('adds beforeNumber and limit as query parameters', async () => {
      mockProjectRequest.mockResolvedValue([build]);
      await listBuilds(PROJECT_ID, { beforeNumber: 5, limit: 50 });
      const [path] = mockProjectRequest.mock.calls[0]!;
      expect(path).toBe(`/${encodeURIComponent(PROJECT_ID)}/builds?beforeNumber=5&limit=50`);
    });

    it('adds only limit when beforeNumber is omitted', async () => {
      mockProjectRequest.mockResolvedValue([build]);
      await listBuilds(PROJECT_ID, { limit: 25 });
      const [path] = mockProjectRequest.mock.calls[0]!;
      expect(path).toBe(`/${encodeURIComponent(PROJECT_ID)}/builds?limit=25`);
    });

    it('propagates projectRequest errors unchanged', async () => {
      const error = new Error('network');
      mockProjectRequest.mockRejectedValue(error);
      await expect(listBuilds(PROJECT_ID)).rejects.toBe(error);
    });

    it('rejects when the response is not a valid build array', async () => {
      mockProjectRequest.mockResolvedValue({ invalid: true });
      await expect(listBuilds(PROJECT_ID)).rejects.toThrow();
    });
  });

  describe('getBuild', () => {
    it('requests a single build by id', async () => {
      mockProjectRequest.mockResolvedValue(build);
      const result = await getBuild(PROJECT_ID, BUILD_ID);
      const [path] = mockProjectRequest.mock.calls[0]!;
      expect(path).toBe(`/${encodeURIComponent(PROJECT_ID)}/builds/${encodeURIComponent(BUILD_ID)}`);
      expect(result).toEqual(build);
    });

    it('rejects when the response is not a valid build', async () => {
      mockProjectRequest.mockResolvedValue({ id: BUILD_ID });
      await expect(getBuild(PROJECT_ID, BUILD_ID)).rejects.toThrow();
    });
  });

  describe('triggerBuild', () => {
    it('posts a JSON sourceRef with Content-Type header', async () => {
      mockProjectRequest.mockResolvedValue(build);
      const result = await triggerBuild(PROJECT_ID, 'feature/x');
      const [path, init] = mockProjectRequest.mock.calls[0]!;
      expect(path).toBe(`/${encodeURIComponent(PROJECT_ID)}/builds`);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(init?.body as string)).toEqual({ sourceRef: 'feature/x' });
      expect(result).toEqual(build);
    });

    it('rejects when the response is not a valid build', async () => {
      mockProjectRequest.mockResolvedValue({ status: 'queued' });
      await expect(triggerBuild(PROJECT_ID, 'main')).rejects.toThrow();
    });
  });

  describe('cancelBuild', () => {
    it('posts to the cancel endpoint without a body', async () => {
      mockProjectRequest.mockResolvedValue(build);
      const result = await cancelBuild(PROJECT_ID, BUILD_ID);
      const [path, init] = mockProjectRequest.mock.calls[0]!;
      expect(path).toBe(`/${encodeURIComponent(PROJECT_ID)}/builds/${encodeURIComponent(BUILD_ID)}/cancel`);
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeUndefined();
      expect(result).toEqual(build);
    });

    it('rejects when the response is not a valid build', async () => {
      mockProjectRequest.mockResolvedValue({});
      await expect(cancelBuild(PROJECT_ID, BUILD_ID)).rejects.toThrow();
    });
  });

  describe('listBuildLogs', () => {
    it('requests logs with no query when no options', async () => {
      mockProjectRequest.mockResolvedValue([logEvent]);
      const result = await listBuildLogs(PROJECT_ID, BUILD_ID);
      const [path, init] = mockProjectRequest.mock.calls[0]!;
      expect(path).toBe(`/${encodeURIComponent(PROJECT_ID)}/builds/${encodeURIComponent(BUILD_ID)}/logs`);
      expect(init).toBeUndefined();
      expect(result).toEqual([logEvent]);
    });

    it('adds seq and limit as query parameters', async () => {
      mockProjectRequest.mockResolvedValue([logEvent]);
      await listBuildLogs(PROJECT_ID, BUILD_ID, { seq: 10, limit: 100 });
      const [path] = mockProjectRequest.mock.calls[0]!;
      expect(path).toBe(`/${encodeURIComponent(PROJECT_ID)}/builds/${encodeURIComponent(BUILD_ID)}/logs?seq=10&limit=100`);
    });

    it('rejects when the response is not a valid log event array', async () => {
      mockProjectRequest.mockResolvedValue([{ seq: 1 }]);
      await expect(listBuildLogs(PROJECT_ID, BUILD_ID)).rejects.toThrow();
    });
  });

  describe('createBuildStreamTicket', () => {
    it('posts to the ticket endpoint without a body', async () => {
      mockProjectRequest.mockResolvedValue(ticket);
      const result = await createBuildStreamTicket(PROJECT_ID, BUILD_ID);
      const [path, init] = mockProjectRequest.mock.calls[0]!;
      expect(path).toBe(`/${encodeURIComponent(PROJECT_ID)}/builds/${encodeURIComponent(BUILD_ID)}/log-stream-ticket`);
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeUndefined();
      expect(result).toEqual(ticket);
    });

    it('rejects when the response is not a valid ticket', async () => {
      mockProjectRequest.mockResolvedValue({ ticket: 'short' });
      await expect(createBuildStreamTicket(PROJECT_ID, BUILD_ID)).rejects.toThrow();
    });
  });

  describe('buildLogStreamUrl', () => {
    it('returns a same-origin API URL without query or access token', () => {
      const url = buildLogStreamUrl(PROJECT_ID, BUILD_ID);
      expect(url).toBe(`/api/v1/projects/${encodeURIComponent(PROJECT_ID)}/builds/${encodeURIComponent(BUILD_ID)}/logs/stream`);
      expect(url).not.toContain('ticket=');
      expect(url).not.toContain('token=');
      expect(url).not.toContain('access_token=');
      expect(mockProjectRequest).not.toHaveBeenCalled();
    });

    it('includes after and ticket in the query string when provided', () => {
      const url = buildLogStreamUrl(PROJECT_ID, BUILD_ID, { after: 3, ticket: ticket.ticket });
      expect(url).toContain(`after=3`);
      expect(url).toContain(`ticket=${ticket.ticket}`);
      expect(url).not.toContain('token=');
      expect(url).not.toContain('access_token=');
      expect(mockProjectRequest).not.toHaveBeenCalled();
    });
  });
});
