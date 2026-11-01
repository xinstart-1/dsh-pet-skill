/**
 * runtime-status 的纯逻辑单测：不碰文件系统，Electron 探测全部注入。
 * @module dsh-pet/src/host/runtime-status.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeStatus } from './runtime-status.ts';

/** 造一个注入齐全的 store；`resolve` 可换成场景需要的返回。 */
function make(resolve: () => string | undefined = () => undefined) {
  return createRuntimeStatus({
    resolve,
    version: () => '43.3.0',
    electronDir: () => '/dsh/electron',
    logPath: () => '/dsh/logs.txt',
  });
}

describe('runtime-status', () => {
  it('初始快照：探测不到 = ready false、无错误、非下载中', () => {
    const s = make().snapshot();
    assert.equal(s.electron.ready, false);
    assert.equal(s.electron.path, null);
    assert.equal(s.electron.downloading, false);
    assert.equal(s.electron.lastError, null);
    assert.equal(s.electron.lastErrorAt, null);
    assert.equal(s.electron.version, '43.3.0');
    assert.equal(s.logPath, '/dsh/logs.txt');
    assert.equal(s.electronDir, '/dsh/electron');
  });

  it('探测命中 = ready true 且带路径；每次快照都实时重探', () => {
    let hit: string | undefined = '/dsh/electron/electron.exe';
    const store = make(() => hit);
    assert.equal(store.snapshot().electron.path, hit);
    hit = undefined; // 文件被删：下一拍就要反映出来，不能缓存旧结论
    assert.equal(store.snapshot().electron.ready, false);
  });

  it('begin → downloading true；end(false) 记录原因与时间', () => {
    const store = make();
    store.beginElectronDownload();
    assert.equal(store.snapshot().electron.downloading, true);
    store.endElectronDownload(false, '网络不可达');
    const s = store.snapshot();
    assert.equal(s.electron.downloading, false);
    assert.equal(s.electron.lastError, '网络不可达');
    assert.ok(typeof s.electron.lastErrorAt === 'number' && s.electron.lastErrorAt > 0);
  });

  it('end(true) 不清历史失败——上次的失败原因仍然值得被看见', () => {
    const store = make();
    store.beginElectronDownload();
    store.endElectronDownload(false, '第一次失败');
    store.beginElectronDownload();
    store.endElectronDownload(true);
    const s = store.snapshot();
    assert.equal(s.electron.downloading, false);
    assert.equal(s.electron.lastError, '第一次失败');
  });

  it('缺省 message 也有兜底文案', () => {
    const store = make();
    store.beginElectronDownload();
    store.endElectronDownload(false);
    assert.match(store.snapshot().electron.lastError ?? '', /下载失败/);
  });

  it('inProcess 跟随 DSH_PET_IN_PROCESS 环境变量', () => {
    const prev = process.env.DSH_PET_IN_PROCESS;
    try {
      delete process.env.DSH_PET_IN_PROCESS;
      assert.equal(make().snapshot().inProcess, false);
      process.env.DSH_PET_IN_PROCESS = '1';
      assert.equal(make().snapshot().inProcess, true);
    } finally {
      if (prev === undefined) delete process.env.DSH_PET_IN_PROCESS;
      else process.env.DSH_PET_IN_PROCESS = prev;
    }
  });
});
