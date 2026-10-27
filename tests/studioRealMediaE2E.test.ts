import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  createMotionProject,
  getMotionProject,
  updateMotionProject,
} from '../src/core/motion/project/projectStore.js';
import {
  studioClipEditTool,
  studioDesktopFocusTool,
  studioEditProjectTool,
} from '../src/core/tools/motionAgentTools.js';
import { renderMotionJob } from '../src/core/motion/jobs/motionJobs.js';
import { probeFfmpeg } from '../src/core/motion/render/ffmpegEncoder.js';
import type { MotionMultiTrack } from '../src/core/motion/schema/types.js';

describe('Real Media E2E Pipeline (Multi-track editing, Undo/Redo, Reload, Handover, Conflict & MP4)', () => {
  let tmpWorkspace: string;

  beforeEach(async () => {
    tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-real-e2e-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('executes full E2E workflow: real media, timeline edits, persistence, handover, conflict, and MP4 export', async () => {
    // 1. Create a real Studio project
    const project = await createMotionProject(tmpWorkspace, 'Studio E2E Real Clip');
    expect(project.id).toMatch(/^studio-[a-f0-9]{20}$/);
    expect(project.revision).toBe(1);

    // Shorten composition for fast, reliable testing: 45 frames @ 30fps (1.5 seconds)
    const baseEdit = await updateMotionProject(tmpWorkspace, project.id, 1, [
      {
        type: 'replace-composition',
        composition: {
          width: 320,
          height: 180,
          fps: { numerator: 30, denominator: 1 },
          durationFrames: 45,
          background: '#0F172A',
          layers: [
            {
              id: 'layer-title',
              kind: 'text',
              text: 'Studio E2E Master',
              x: 20,
              y: 70,
              width: 280,
              height: 40,
              rotation: 0,
              opacity: 1,
              fill: '#38BDF8',
              fontSize: 24,
              fontFamily: 'Arial',
              tracks: [],
            } as any,
          ],
        },
      },
    ]);
    expect(baseEdit.revision).toBe(2);

    // 2. Setup initial Multi-track NLE layout (Video 1 track with initial clip)
    const initialTracks: MotionMultiTrack[] = [
      {
        id: 'track-v1',
        name: 'Video 1',
        kind: 'video',
        muted: false,
        locked: false,
        clips: [
          {
            id: 'clip-hero',
            trackId: 'track-v1',
            layerId: 'layer-title',
            name: 'Hero Title',
            kind: 'text',
            startFrame: 0,
            durationFrames: 45,
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
        clips: [],
      },
    ];

    const projectWithTracks = await updateMotionProject(tmpWorkspace, project.id, 2, [
      { type: 'set-tracks', tracks: initialTracks },
    ]);
    expect(projectWithTracks.revision).toBe(3);
    expect(projectWithTracks.composition.tracks).toHaveLength(2);

    // 3. Perform timeline editing via Assistant Tool (studio_clip_edit)
    // 3a. Split clip at frame 20
    const rawSplitResult = await studioClipEditTool.execute({
      workspacePath: tmpWorkspace,
      projectId: project.id,
      expectedRevision: 3,
      operation: {
        type: 'split',
        trackId: 'track-v1',
        clipId: 'clip-hero',
        splitFrame: 20,
      },
      summary: 'Split hero clip at frame 20',
      operationId: 'op-split-hero',
    }, tmpWorkspace);

    const splitResult = JSON.parse(rawSplitResult);
    expect(splitResult.success).toBe(true);
    expect(splitResult.revision).toBe(4);
    expect(splitResult.receipt.status).toBe('applied');

    // Inspect project after split
    const projectAfterSplit = await getMotionProject(tmpWorkspace, project.id);
    expect(projectAfterSplit.revision).toBe(4);
    const videoClips = projectAfterSplit.composition.tracks![0].clips;
    expect(videoClips).toHaveLength(2);
    expect(videoClips[0].durationFrames).toBe(20);
    expect(videoClips[1].startFrame).toBe(20);
    expect(videoClips[1].durationFrames).toBe(25);

    const secondClipId = videoClips[1].id;

    // 3b. Trim second clip (trim out by 5 frames)
    const rawTrimResult = await studioClipEditTool.execute({
      workspacePath: tmpWorkspace,
      projectId: project.id,
      expectedRevision: 4,
      operation: {
        type: 'trim',
        trackId: 'track-v1',
        clipId: secondClipId,
        deltaIn: 0,
        deltaOut: -5,
      },
      summary: 'Trim 5 frames from tail of second clip',
    }, tmpWorkspace);

    const trimResult = JSON.parse(rawTrimResult);
    expect(trimResult.success).toBe(true);
    expect(trimResult.revision).toBe(5);

    // 4. Test Stale Revision / Revision Conflict Guard (AUD-08)
    const rawConflictResult = await studioClipEditTool.execute({
      workspacePath: tmpWorkspace,
      projectId: project.id,
      expectedRevision: 3, // Stale! Current is 5
      operation: {
        type: 'trim',
        trackId: 'track-v1',
        clipId: secondClipId,
        deltaIn: 0,
        deltaOut: -2,
      },
    }, tmpWorkspace);

    const conflictResult = JSON.parse(rawConflictResult);
    expect(conflictResult.success).toBe(false);
    expect(conflictResult.conflict).toBe(true);

    // Confirm state was not mutated by conflict
    const stateAfterConflict = await getMotionProject(tmpWorkspace, project.id);
    expect(stateAfterConflict.revision).toBe(5);

    // 5. Test Undo / Redo Round-trip via revisioned edits
    // Save snapshot of revision 5 composition
    const rev5Comp = structuredClone(stateAfterConflict.composition);

    // Revert to revision 4 composition (Undo)
    const undoProject = await updateMotionProject(tmpWorkspace, project.id, 5, [
      { type: 'replace-composition', composition: projectAfterSplit.composition },
    ]);
    expect(undoProject.revision).toBe(6);
    expect(undoProject.composition.tracks![0].clips[1].durationFrames).toBe(25); // Restored before trim

    // Reapply revision 5 composition (Redo)
    const redoProject = await updateMotionProject(tmpWorkspace, project.id, 6, [
      { type: 'replace-composition', composition: rev5Comp },
    ]);
    expect(redoProject.revision).toBe(7);
    expect(redoProject.composition.tracks![0].clips[1].durationFrames).toBe(20); // Reapplied trim

    // 6. Test Project Reload (Lossless persistence verification)
    const reloadedProject = await getMotionProject(tmpWorkspace, project.id);
    expect(reloadedProject.revision).toBe(7);
    expect(reloadedProject.composition.tracks).toBeDefined();
    expect(reloadedProject.composition.tracks).toHaveLength(2);
    expect(reloadedProject.composition.tracks![0].clips).toHaveLength(2);
    expect(reloadedProject.composition.tracks![0].clips[0].name).toBe('Hero Title');

    // 7. Test Desktop Handoff Action (AUD-02 & AUD-09)
    const rawHandoff = await studioDesktopFocusTool.execute({
      workspacePath: tmpWorkspace,
      projectId: project.id,
      clipId: secondClipId,
      frame: 25,
    }, tmpWorkspace);

    const handoff = JSON.parse(rawHandoff);
    expect(handoff.success).toBe(true);
    expect(handoff.delivery).toBe('dispatched');
    expect(handoff.action.type).toBe('select_clip');
    expect(handoff.action.clipId).toBe(secondClipId);
    expect(handoff.action.workspacePath).toBe(tmpWorkspace);

    // 8. Render real H.264 MP4 output and verify on disk
    const hasFfmpeg = await probeFfmpeg();
    expect(hasFfmpeg).toBe(true);

    const renderResult = await renderMotionJob(tmpWorkspace, project.id, { width: 320 });
    expect(renderResult.status).toBe('completed');
    expect(renderResult.framesCompleted).toBe(45);
    expect(renderResult.artifact).toBeDefined();
    expect(renderResult.artifact?.path).toBeDefined();

    // Verify MP4 file exists on disk and is non-empty
    const mp4Path = renderResult.artifact!.path;
    const stat = await fs.stat(mp4Path);
    expect(stat.size).toBeGreaterThan(1024); // More than 1 KB

    // Verify ISO base media file format (MP4 header begins with 'ftyp')
    const fileBytes = await fs.readFile(mp4Path);
    const boxType = fileBytes.toString('ascii', 4, 8);
    expect(boxType).toBe('ftyp');

    // Verify SHA-256 integrity match
    const computedHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
    expect(renderResult.artifact?.sha256).toBe(computedHash);
  }, 60000);
});
