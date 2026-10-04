/**
 * 项目声明（interface.json / ProjectInterface v2）的窄解析与连接规划。
 *
 * 这是"认识项目"的唯一一份实现：控制器声明 → daemon connect 参数、
 * 资源声明 → resource 目录、task 声明 → run 入口解析。
 */
export { parseJsonc } from './jsonc.js'
export {
  loadInterface,
  findInterfaceFile,
  type DisplayDecl,
  type GamepadDecl,
  type InterfaceController,
  type InterfaceProblem,
  type InterfaceResource,
  type InterfaceTask,
  type LoadedInterface,
  type Win32Decl,
} from './load.js'
export {
  planController,
  resolveResourcePaths,
  type ControllerPlan,
  type DeviceLike,
  type PlanOverrides,
  type ResourcePlan,
} from './plan.js'
