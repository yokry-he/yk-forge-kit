import type { BuildDiagnosisCategory } from '@forgekit/contracts';

interface DiagnosisCopy { title: string; cause: string; steps: string[] }
export const buildDiagnosisCopy: Record<BuildDiagnosisCategory, DiagnosisCopy> = {
  dependency_registry_network: {
    title: '依赖源网络异常', cause: '安装依赖时无法稳定连接依赖源，可能是网络或 DNS 暂时不可用。',
    steps: ['稍后再次构建，排除临时网络波动。', '检查项目配置的依赖源地址是否正确。', '请管理员检查构建环境的 DNS、代理和依赖源连通性。'],
  },
  dependency_lockfile_mismatch: {
    title: '锁文件与配置不一致', cause: '依赖声明与锁文件不一致，安装工具无法按锁定的版本安装。',
    steps: ['使用与构建环境一致的包管理器更新依赖和锁文件。', '将依赖声明与锁文件一起保存到构建使用的源码中。', '确认本地安装和构建通过后，再次构建。'],
  },
  dependency_missing_package: {
    title: '依赖包或版本不存在', cause: '依赖源中找不到需要的包或版本；私有包也可能因权限不足而返回不存在。',
    steps: ['检查日志中的包名与版本是否正确。', '确认当前依赖源提供该包和版本。', '私有包请联系管理员核对访问权限，勿把凭据粘贴到日志中。'],
  },
  install_network_disabled: {
    title: '安装阶段禁止联网', cause: '依赖安装失败，当前安装容器使用 none 网络策略，无法从外部下载依赖。',
    steps: ['请管理员检查 FORGEKIT_BUILD_INSTALL_NETWORK 配置。', '如需下载依赖，由管理员评估 outbound 或受控 registry 代理策略。', '配置生效后再次构建；源码编译阶段仍保持断网。'],
  },
  compile_error: {
    title: '代码编译错误', cause: '编译工具发现代码、类型或模块引用问题，无法生成可用页面。',
    steps: ['查看相关日志中指出的文件与行号，先修复第一处报错。', '检查引用路径、依赖声明和类型是否正确。', '使用项目实际的构建脚本在本地验证后，再次构建。'],
  },
  out_of_memory: {
    title: '可能内存不足', cause: '日志提示内存耗尽，或进程以 137 退出。137 也可能是其他强制终止，需要管理员核实。',
    steps: ['检查最近是否增加了大型依赖或构建任务。', '如项目支持，降低构建并发或减少构建内容。', '请管理员检查容器内存限制和系统终止记录。'],
  },
  timeout: {
    title: '构建超时', cause: '安装或编译超过了允许的执行时间，任务已被中断。',
    steps: ['查看日志最后停在哪一步，确认安装重试或编译是否卡住。', '排查网络并精简耗时的构建任务。', '请管理员评估 BUILD_TIMEOUT_MS 是否满足项目需要。'],
  },
  runner_unavailable: {
    title: '构建环境不可用', cause: '平台无法正常启动或继续执行构建，可能与 Docker、镜像或任务执行进程有关。',
    steps: ['请管理员检查 Worker、Docker 服务和任务队列。', '确认配置的构建镜像已在执行主机上准备好。', '环境恢复后创建一次新构建。'],
  },
  artifact_missing: {
    title: '构建产物缺失', cause: '执行结束后未找到预期的输出目录或入口文件，或产物存储目录不可用，无法保存产物。',
    steps: ['检查构建脚本是否实际生成了文件。', '核对模板输出目录与构建工具的输出配置。', '请管理员检查 FORGEKIT_ARTIFACT_DIR 目录及写入权限。', '确认入口文件存在且存储可用后，再次构建。'],
  },
  unknown: {
    title: '暂未识别失败原因', cause: '当前信息不足以确定原因。请查看完整日志，诊断提示仅供排查参考。',
    steps: ['在完整日志中找到最早出现的实际报错。', '记录构建编号、时间和已脱敏的报错信息，联系管理员。', '按项目实际构建步骤在本地复现问题。'],
  },
};

export function diagnosisCopy(category?: string): DiagnosisCopy {
  return category && Object.hasOwn(buildDiagnosisCopy, category)
    ? buildDiagnosisCopy[category as BuildDiagnosisCategory] : buildDiagnosisCopy.unknown;
}
