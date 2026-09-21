import { T } from '../common/Theme';
import { PAGE_DETAIL, PAGE_FORM, PAGE_HISTORY, PAGE_LOGIN, Route } from '../common/Route';
import { ListScreen } from './ListScreen';
import { DetailScreen } from './DetailScreen';
import { FormScreen } from './FormScreen';
import { HistoryScreen } from './HistoryScreen';
import { LoginScreen } from './LoginScreen';

@Entry
@Component
struct Index {
  @Provide('nav') stack: NavPathStack = new NavPathStack();

  build() {
    Navigation(this.stack) {
      ListScreen()
    }
    .navDestination(this.pageMap)
    .hideTitleBar(true)
    .mode(NavigationMode.Stack)
    .backgroundColor(T.BG)
    .width('100%')
    .height('100%')
  }

  @Builder
  pageMap(name: string, param: object) {
    if (name === PAGE_DETAIL) {
      NavDestination() {
        DetailScreen({ timerId: Route.argId })
      }
    } else if (name === PAGE_FORM) {
      NavDestination() {
        FormScreen({ timerId: Route.argId })
      }
    } else if (name === PAGE_HISTORY) {
      NavDestination() {
        HistoryScreen()
      }
    } else if (name === PAGE_LOGIN) {
      NavDestination() {
        LoginScreen()
      }
    }
  }
}
