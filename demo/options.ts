// 先装好 chrome 替身，再加载真实的设置页入口（它会在导入时自动渲染）。
import './mock-chrome';
import './theme-force';
import '../src/options/index';
