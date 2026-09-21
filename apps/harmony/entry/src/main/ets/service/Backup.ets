// 全量导出/导入备份（与 Windows electron/exporter.ts 同一 JSON 形状，文件可互导）。
// 导出优先走系统文档选择器写到用户可见位置；被取消或不可用时退回应用沙箱并把路径回显给用户。
import { picker, fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Repo } from '../data/Repo';

const TAG = 'TimeMarkBackup';
const APP_DIR = 'timemark';

export class BackupResult {
  ok: boolean = false;
  message: string = '';
  where: string = '';
}

function stamp(): string {
  const d = new Date();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${d.getFullYear()}-${m < 10 ? `0${m}` : m}-${day < 10 ? `0${day}` : day}`;
}

export class Backup {
  private ctx: common.UIAbilityContext | null = null;
  private repo: Repo;

  constructor(repo: Repo) {
    this.repo = repo;
  }

  bind(ctx: common.UIAbilityContext): void {
    this.ctx = ctx;
  }

  /** 导出：写文本 → 选择器目标或沙箱文件 */
  async exportToFile(): Promise<BackupResult> {
    const r = new BackupResult();
    const name = `timemark-backup-${stamp()}.json`;
    let text = '';
    try {
      text = await this.repo.exportJson();
    } catch (e) {
      r.message = `导出失败：${e}`;
      return r;
    }
    if (this.ctx !== null) {
      try {
        const doc = new picker.DocumentViewPicker(this.ctx);
        const opts: picker.DocumentSaveOptions = { newFileNames: [name] };
        const uris = await doc.save(opts);
        if (uris.length > 0) {
          const fd = await fs.open(uris[0], fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
          await fs.write(fd.fd, text);
          await fs.close(fd);
          r.ok = true;
          r.where = name;
          r.message = `已导出为 ${name}`;
          return r;
        }
      } catch (e) {
        hilog.warn(0x0000, TAG, `文档选择器不可用，退回沙箱：${e}`);
      }
    }
    // 沙箱兜底：不申请任何权限，路径回显给用户
    try {
      const dir = `${this.ctx === null ? '' : this.ctx.filesDir}/${APP_DIR}`;
      if (!await fs.access(dir)) await fs.mkdir(dir, true);
      const path = `${dir}/${name}`;
      const fd = await fs.open(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      await fs.write(fd.fd, text);
      await fs.close(fd);
      r.ok = true;
      r.where = path;
      r.message = `已导出到 ${path}`;
      return r;
    } catch (e) {
      r.message = `导出失败：${e}`;
      return r;
    }
  }

  /** 导入：选一个备份文件 → 交给 Repo 按列白名单覆盖式合并并重新入队 */
  async importFromFile(): Promise<BackupResult> {
    const r = new BackupResult();
    if (this.ctx === null) {
      r.message = '上下文未就绪';
      return r;
    }
    let uri = '';
    try {
      const doc = new picker.DocumentViewPicker(this.ctx);
      const uris = await doc.select({});
      if (uris.length === 0) {
        r.message = '未选择文件';
        return r;
      }
      uri = uris[0];
    } catch (e) {
      r.message = `打开文件失败：${e}`;
      return r;
    }
    let text = '';
    try {
      const st = await fs.stat(uri);
      const fd = await fs.open(uri, fs.OpenMode.READ_ONLY);
      const buf = new ArrayBuffer(st.size);
      await fs.read(fd.fd, buf);
      await fs.close(fd);
      text = util.TextDecoder.create('utf-8').decodeToString(new Uint8Array(buf));
    } catch (e) {
      r.message = `读取备份失败：${e}`;
      return r;
    }
    try {
      const s = await this.repo.importJson(text);
      if (s.error.length > 0) {
        r.message = s.error;
        return r;
      }
      r.ok = true;
      r.where = uri;
      r.message = `已导入：计时 ${s.timer_item} · 记录 ${s.timer_record} · 标签 ${s.tag} · 连接 ${s.timer_tag} · 里程碑 ${s.milestone}`;
      return r;
    } catch (e) {
      r.message = `导入失败：${e}`;
      return r;
    }
  }
}
