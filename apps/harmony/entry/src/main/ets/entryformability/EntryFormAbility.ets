// 桌面服务卡片的数据侧（FormExtensionAbility）。
// 卡片自身不查库：onAddForm 必须同步返回，所以读应用主进程缓存在偏好里的快照；
// 之后的刷新由主进程 CardUpdater 调 formProvider.updateForm 推送（每次结算/操作后）。
import { FormExtensionAbility, formBindingData, formInfo } from '@kit.FormKit';
import { Want } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { CardSnapshot, PREFS_NAME, dropFormId, readSnapshot, upsertFormId } from '../common/CardSnapshot';

const TAG = 'TimeMarkForm';

export default class EntryFormAbility extends FormExtensionAbility {
  onAddForm(want: Want): formBindingData.FormBindingData {
    const formId = `${want.parameters?.[formInfo.FormParam.IDENTITY_KEY] ?? ''}`;
    const dim = `${want.parameters?.[formInfo.FormParam.DIMENSION_KEY] ?? '2*2'}`;
    this.prefs((p) => upsertFormId(p, formId, dim === '4' ? '2*4' : '2*2'));
    return formBindingData.createFormBindingData(this.build());
  }

  onCastToNormalForm(formId: string): void {
    this.prefs((p) => upsertFormId(p, `${formId}`, '2*2'));
  }

  onUpdateForm(formId: string): void {
    hilog.info(0x0000, TAG, `系统请求刷新 ${formId}`);
  }

  onFormEvent(formId: string, message: string): void {
    hilog.info(0x0000, TAG, `卡片事件 ${formId}: ${message}`);
  }

  onRemoveForm(formId: string): void {
    this.prefs((p) => dropFormId(p, `${formId}`));
  }

  onAcquireFormState(want: Want): formInfo.FormState {
    return formInfo.FormState.READY;
  }

  private build(): Record<string, Object> {
    let s = new CardSnapshot();
    try {
      s = readSnapshot(preferences.getPreferencesSync(this.context, { name: PREFS_NAME }));
    } catch (e) {
      hilog.warn(0x0000, TAG, `读快照失败，用占位: ${e}`);
    }
    const o: Record<string, Object> = {};
    o['title'] = s.title as Object;
    o['reading'] = s.reading as Object;
    o['sub'] = s.sub as Object;
    o['color'] = s.color as Object;
    o['running'] = s.running as Object;
    return o;
  }

  private prefs(fn: (p: preferences.Preferences) => void): void {
    try {
      fn(preferences.getPreferencesSync(this.context, { name: PREFS_NAME }));
    } catch (e) {
      hilog.warn(0x0000, TAG, `卡片登记失败: ${e}`);
    }
  }
}
