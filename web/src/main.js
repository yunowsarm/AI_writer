/** 前端入口：按需注册图标，加载通用样式和模块页面。 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import {
  Grid,
  MagicStick,
  Document,
  Collection,
  Compass,
  Star,
  Setting,
  ArrowDown,
  ArrowRight,
  QuestionFilled,
  EditPen,
  Calendar,
  FolderOpened,
  CollectionTag,
  Clock,
  Lightning,
  Search,
  View,
  Pointer,
  StarFilled,
  Plus,
  Check,
  Delete,
  Refresh,
  Download,
  SwitchButton,
  User,
  Loading,
  Sunny,
  Opportunity,
  TrendCharts,
  Sugar,
  Key,
  House,
  OfficeBuilding,
  TopRight,
  Right,
  Back,
  RefreshLeft,
  RefreshRight,
  Top,
  Bottom,
  Connection,
  Switch,
  Close,
  DataLine
} from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './styles/base.css'
import './styles/system.css'
import './styles/theme-palette.css'
import './styles/theme.css'
import './styles/readability.css'
import App from './App.vue'
import { router } from './router'
const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })
// 显式注册页面实际使用的 SVG 图标，与 Element Plus 组件保持一致，避免依赖系统 emoji 字体。
for (const [name, icon] of Object.entries({
  Grid,
  MagicStick,
  Document,
  Collection,
  Compass,
  Star,
  Setting,
  ArrowDown,
  ArrowRight,
  QuestionFilled,
  EditPen,
  Calendar,
  FolderOpened,
  CollectionTag,
  Clock,
  Lightning,
  Search,
  View,
  Pointer,
  StarFilled,
  Plus,
  Check,
  Delete,
  Refresh,
  Download,
  SwitchButton,
  User,
  Loading,
  Sunny,
  Opportunity,
  TrendCharts,
  Sugar,
  Key,
  House,
  OfficeBuilding,
  TopRight,
  Right,
  Back,
  RefreshLeft,
  RefreshRight,
  Top,
  Bottom,
  Connection,
  Switch,
  Close,
  DataLine
}))
  app.component(name, icon)
app.mount('#app')
