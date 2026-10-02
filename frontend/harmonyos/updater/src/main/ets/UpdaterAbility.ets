import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
export default class UpdaterAbility extends UIAbility {
 onWindowStageCreate(stage: window.WindowStage): void { stage.loadContent('pages/UpdaterIndex'); }
}
