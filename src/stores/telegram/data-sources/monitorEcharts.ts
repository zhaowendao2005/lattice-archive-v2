/**
 * ECharts 按需注册（唯一的 echarts 静态入口）。
 *
 * 该模块只被 telegramMonitorDataSource 动态 import：ECharts 因此不会进入应用入口，
 * 也不会随工作区路由预取一起加载，只有真正打开监控页并挂载图表时才下载。
 * 静态具名导入让打包器可以裁掉未使用的图表与组件。
 */
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  AxisPointerComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  AxisPointerComponent,
  CanvasRenderer,
]);

export { echarts };
