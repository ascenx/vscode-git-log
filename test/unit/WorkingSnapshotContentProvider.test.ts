import { describe, expect, it, vi } from 'vitest';

const { from } = vi.hoisted(() => ({
  from: vi.fn((value: { scheme: string; path: string; query: string }) => value),
}));

vi.mock('vscode', () => ({ Uri: { from } }));

describe('WorkingSnapshotContentProvider', () => {
  it('creates language-detectable virtual documents for unsaved editor content', async () => {
    const modulePath = '../../src/diff/WorkingSnapshotContentProvider';
    const providerModule = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
    expect(providerModule, 'WorkingSnapshotContentProvider must exist').toBeDefined();
    if (!providerModule) return;
    const provider = new providerModule.WorkingSnapshotContentProvider();

    const uri = provider.create('src/features/app.ts', 'unsaved\ncontent\n');

    expect(uri).toMatchObject({
      scheme: 'git-log-workbench-working',
      path: '/src/features/app.ts',
    });
    await expect(provider.provideTextDocumentContent(uri)).resolves.toBe('unsaved\ncontent\n');
    await expect(
      provider.provideTextDocumentContent({ ...uri, query: 'id=missing' }),
    ).rejects.toThrow('Unknown working-file snapshot');
  });

  it('clears retained snapshots when disposed', async () => {
    const { WorkingSnapshotContentProvider } = await import('../../src/diff/WorkingSnapshotContentProvider');
    const provider = new WorkingSnapshotContentProvider();
    const uri = provider.create('app.ts', 'content\n');

    provider.dispose();

    await expect(provider.provideTextDocumentContent(uri)).rejects.toThrow(
      'Unknown working-file snapshot',
    );
  });

  it('enforces per-file and total byte limits without evicting live snapshots', async () => {
    const { WorkingSnapshotContentProvider } = await import('../../src/diff/WorkingSnapshotContentProvider');
    const provider = new WorkingSnapshotContentProvider(8, 12);
    const first = provider.create('first.ts', '12345678');

    expect(() => provider.create('too-large.ts', '123456789')).toThrow('too large');
    expect(() => provider.create('over-total.ts', '12345')).toThrow('memory limit');
    await expect(provider.provideTextDocumentContent(first)).resolves.toBe('12345678');

    provider.release(first);
    const replacement = provider.create('replacement.ts', '12345');
    await expect(provider.provideTextDocumentContent(replacement)).resolves.toBe('12345');
    await expect(provider.provideTextDocumentContent(first)).rejects.toThrow(
      'Unknown working-file snapshot',
    );
  });
});
