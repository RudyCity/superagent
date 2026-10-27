import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createMotionProject,
  inspectMotionProject,
  updateMotionProject,
} from '../src/core/motion/project/projectStore';
import {
  validateMotionProject,
  validateMotionMultiTracks,
} from '../src/core/motion/schema/validation';
import {
  studioClipEditTool,
  studioDesktopFocusTool,
  studioEditProjectTool,
} from '../src/core/tools/motionAgentTools';
import { evaluateFrame } from '../src/core/motion/timeline/evaluateFrame';
import type { MotionMultiTrack, MotionProject } from '../src/core/motion/schema/types';

describe('SuperAgent Core Motion Multi-Track & Clip Editing (AUD-01, AUD-02, AUD-06, AUD-10)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-motion-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('validates multi-track schema structure and prevents invalid tracks', () => {
    const validTracks: MotionMultiTrack[] = [
      {
        id: 'track-v1',
        name: 'Video 1',
        kind: 'video',
        muted: false,
        locked: false,
        clips: [
          {
            id: 'clip-1',
            trackId: 'track-v1',
            layerId: 'layer-1',
            name: 'Intro Text',
            kind: 'text',
            startFrame: 0,
            durationFrames: 60,
            trimInFrames: 0,
            trimOutFrames: 0,
          },
        ],
      },
      {
        id: 'track-a1',
        name: 'Audio 1',
        kind: 'audio',
        muted: false,
        locked: false,
        clips: [
          {
            id: 'clip-2',
            trackId: 'track-a1',
            name: 'Voice Track',
            kind: 'audio',
            startFrame: 10,
            durationFrames: 50,
            trimInFrames: 0,
            trimOutFrames: 0,
          },
        ],
      },
    ];

    const errors = validateMotionMultiTracks(validTracks, 120);
    expect(errors).toHaveLength(0);

    const invalidTracks = [
      {
        id: 'invalid-track',
        name: 'Video 1',
        kind: 'invalid-kind',
        clips: [],
      },
    ] as any;

    const invalidErrors = validateMotionMultiTracks(invalidTracks, 120);
    expect(invalidErrors.length).toBeGreaterThan(0);
  });

  it('applies atomic clip operations: set-tracks, split, trim, move, delete', async () => {
    const project = await createMotionProject(tmpDir, 'MultiTrack Test');
    expect(project.revision).toBe(1);

    const initialTracks: MotionMultiTrack[] = [
      {
        id: 'track-v1',
        name: 'Video 1',
        kind: 'video',
        muted: false,
        locked: false,
        clips: [
          {
            id: 'clip-1',
            trackId: 'track-v1',
            layerId: project.composition.layers[0].id,
            name: 'Title Clip',
            kind: 'text',
            startFrame: 0,
            durationFrames: 60,
            trimInFrames: 0,
            trimOutFrames: 0,
          },
        ],
      },
    ];

    // 0. Set tracks
    const projectWithTracks = await updateMotionProject(tmpDir, project.id, 1, [
      { type: 'set-tracks', tracks: initialTracks },
    ]);
    expect(projectWithTracks.revision).toBe(2);
    expect(projectWithTracks.composition.tracks).toHaveLength(1);

    // 1. Split clip at frame 30
    const splitProject = await updateMotionProject(tmpDir, project.id, 2, [
      {
        type: 'split-clip',
        trackId: 'track-v1',
        clipId: 'clip-1',
        splitFrame: 30,
      },
    ]);
    expect(splitProject.revision).toBe(3);
    const clipsAfterSplit = splitProject.composition.tracks?.[0].clips;
    expect(clipsAfterSplit).toHaveLength(2);
    expect(clipsAfterSplit?.[0].durationFrames).toBe(30);
    expect(clipsAfterSplit?.[1].startFrame).toBe(30);
    expect(clipsAfterSplit?.[1].durationFrames).toBe(30);

    const secondClipId = clipsAfterSplit?.[1].id!;

    // 2. Move second clip to frame 45
    const movedProject = await updateMotionProject(tmpDir, project.id, 3, [
      {
        type: 'move-clip',
        fromTrackId: 'track-v1',
        toTrackId: 'track-v1',
        clipId: secondClipId,
        newStartFrame: 45,
      },
    ]);
    expect(movedProject.revision).toBe(4);
    const secondClipAfterMove = movedProject.composition.tracks?.[0].clips.find(c => c.id === secondClipId);
    expect(secondClipAfterMove?.startFrame).toBe(45);

    // 3. Trim second clip (trim out by -10 frames)
    const trimmedProject = await updateMotionProject(tmpDir, project.id, 4, [
      {
        type: 'trim-clip',
        trackId: 'track-v1',
        clipId: secondClipId,
        deltaIn: 0,
        deltaOut: -10,
      },
    ]);
    expect(trimmedProject.revision).toBe(5);
    const secondClipAfterTrim = trimmedProject.composition.tracks?.[0].clips.find(c => c.id === secondClipId);
    expect(secondClipAfterTrim?.durationFrames).toBe(20);

    // 4. Delete first clip
    const deletedProject = await updateMotionProject(tmpDir, project.id, 5, [
      {
        type: 'delete-clip',
        trackId: 'track-v1',
        clipId: 'clip-1',
      },
    ]);
    expect(deletedProject.revision).toBe(6);
    expect(deletedProject.composition.tracks?.[0].clips).toHaveLength(1);
    expect(deletedProject.composition.tracks?.[0].clips[0].id).toBe(secondClipId);
  });

  it('evaluates frame opacity honoring multi-track clip intervals', async () => {
    const project = await createMotionProject(tmpDir, 'Interval Test');
    const layerId = project.composition.layers[0].id;

    const tracksWithInterval: MotionMultiTrack[] = [
      {
        id: 'track-v1',
        name: 'Video 1',
        kind: 'video',
        muted: false,
        locked: false,
        clips: [
          {
            id: 'clip-interval',
            trackId: 'track-v1',
            layerId,
            name: 'Interval',
            kind: 'text',
            startFrame: 30,
            durationFrames: 30,
            trimInFrames: 0,
            trimOutFrames: 0,
          },
        ],
      },
    ];

    const projectWithTracks = await updateMotionProject(tmpDir, project.id, 1, [
      { type: 'set-tracks', tracks: tracksWithInterval },
    ]);

    // Before clip active range (frame 15) -> opacity should be 0
    const frame15 = evaluateFrame(projectWithTracks, 15);
    expect(frame15.layers[0].values.opacity).toBe(0);

    // Inside clip active range (frame 45) -> opacity should be 1
    const frame45 = evaluateFrame(projectWithTracks, 45);
    expect(frame45.layers[0].values.opacity).toBe(1);

    // After clip active range (frame 70) -> opacity should be 0
    const frame70 = evaluateFrame(projectWithTracks, 70);
    expect(frame70.layers[0].values.opacity).toBe(0);
  });

  it('executes studioClipEditTool with idempotency and returns uniform receipt', async () => {
    const project = await createMotionProject(tmpDir, 'Tool Test Project');
    const layerId = project.composition.layers[0].id;

    const tracks: MotionMultiTrack[] = [
      {
        id: 'track-v1',
        name: 'Video 1',
        kind: 'video',
        muted: false,
        locked: false,
        clips: [
          {
            id: 'clip-split-me',
            trackId: 'track-v1',
            layerId,
            name: 'Split Target',
            kind: 'text',
            startFrame: 0,
            durationFrames: 60,
            trimInFrames: 0,
            trimOutFrames: 0,
          },
        ],
      },
    ];

    await updateMotionProject(tmpDir, project.id, 1, [{ type: 'set-tracks', tracks }]);

    // Call studioClipEditTool to split clip
    const rawResult = await studioClipEditTool.execute({
      workspacePath: tmpDir,
      projectId: project.id,
      expectedRevision: 2,
      operation: {
        type: 'split',
        trackId: 'track-v1',
        clipId: 'clip-split-me',
        splitFrame: 25,
      },
      operationId: 'idem-split-001',
    }, tmpDir);

    const result = JSON.parse(rawResult);
    expect(result.success).toBe(true);
    expect(result.receipt).toBeDefined();
    expect(result.receipt.operationId).toBe('idem-split-001');
    expect(result.receipt.status).toBe('applied');
    expect(result.receipt.revision).toBe(3);
    expect(result.receipt.projectId).toBe(project.id);
    expect(result.revision).toBe(3);

    // Replay same call with same idempotencyKey -> returns cached result without double applying
    const rawReplay = await studioClipEditTool.execute({
      workspacePath: tmpDir,
      projectId: project.id,
      expectedRevision: 2,
      operation: {
        type: 'split',
        trackId: 'track-v1',
        clipId: 'clip-split-me',
        splitFrame: 25,
      },
      operationId: 'idem-split-001',
    }, tmpDir);

    const replay = JSON.parse(rawReplay);
    expect(replay.success).toBe(true);
    expect(replay.revision).toBe(3);
    expect(replay.receipt.operationId).toBe('idem-split-001');
  });

  it('dispatches typed StudioControlAction via studioDesktopFocusTool', async () => {
    const rawResult = await studioDesktopFocusTool.execute({
      workspacePath: tmpDir,
      projectId: 'proj-focus-123',
      clipId: 'clip-target-99',
      frame: 45,
    }, tmpDir);

    const result = JSON.parse(rawResult);
    expect(result.success).toBe(true);
    expect(result.delivery).toBe('dispatched');
    expect(result.projectId).toBe('proj-focus-123');
    expect(result.workspacePath).toBe(tmpDir);
    expect(result.action).toEqual(
      expect.objectContaining({
        type: 'select_clip',
        workspacePath: tmpDir,
        projectId: 'proj-focus-123',
        clipId: 'clip-target-99',
      })
    );
  });
});
