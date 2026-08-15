# Agent Note：在 pi-ai 适配器与 Models UI 中实现 GitHub Copilot OAuth 登录

Status: implemented

[English](2026-08-15-github-copilot-oauth.md) | 中文

## 问题

PR #1 在 OAuth 改造未完成时即合并，留下了编译错误、客户端导出链缺口、fixture 实现不完整，以及登录会话行为未验证等问题。

Models UI 中 `signInOAuth`/`signOutOAuth` 作用域错误导致无法通过编译，提示轮询可能重复回答同一 prompt，且登录 pending 期间没有可用的取消操作。

适配器与代理层还缺少对持久化凭据语义、结构化 provider-auth 错误码、以及特权 RPC 覆盖的完整收口。

## 决策

在现有范围内打通 `github-copilot` 的 provider-auth 全链路。

浏览器/客户端导出链补齐了 provider-auth 公共类型，fixture 补齐 provider-auth 方法与分发入口，`ProviderEditor` 实现了 OAuth 登录/退出/取消、安全链接渲染与 prompt 去重回答。

pi-ai 凭据存储在读取前校验 OAuth/API-key 结构，并与 pi-ai 的 `modify` 语义保持一致（回调返回 `undefined` 表示“保持不变”）。

适配器登录会话在完成/取消/失败后进入清理窗口，结算时会拒绝待答 prompt，避免会话无限滞留。

## 备选方案

继续保留仅 API key 路径并完全不提供 OAuth；该方案被拒绝，因为 `github-copilot` 需要在 Models 页面提供可用的一方登录流程。

把所有具备 OAuth 能力的提供方都标记为可服务；该方案被拒绝，因为本构建只为 `github-copilot` 实现了配套存储与登录流程，`openai-codex` 仍缺少可服务的交互登录能力。

## 安全边界

OAuth 快照与状态保持脱敏：UI 状态、主机 RPC、fixture 数据和错误映射均不暴露 token 字段。

provider-auth 端点继续受 loopback 特权限制，代理层返回稳定结构化错误码（`provider-auth-unsupported`、`provider-auth-login-unknown`、`provider-auth-prompt-unknown`、`provider-auth-cancelled`、`provider-auth-expired`、`provider-auth-provider-failed`）。

可服务 OAuth 范围保持显式：本构建仅 `github-copilot` 标记为可服务，OAuth-only 的 `openai-codex` 仍不出现在新增提供方入口。

## 影响

Models 页面现已支持 GitHub Copilot 的交互式 OAuth 登录/退出，同时保留 API key 配置路径。

prompt 事件按 prompt id 最多回答一次；可选的 GitHub 默认提示可自动空回答；必填提示改为显式 UI 输入后提交。

存储的 token 刷新会通过 harness 凭据 seam 持久化，并可在重建的不可变模型快照之间复用。

## 测试

新增并更新了 store、adapter、proxy、fixture、UI 的定向测试：`packages/llm/llm-pi-ai/tests/oauth-store.spec.ts`、`packages/llm/llm-pi-ai/tests/catalog.spec.ts`、`packages/host/apiproxy/tests/api-proxy-models.spec.ts`、`packages/client/connection/tests/fixture.client.spec.ts`、`packages/client/connection/tests/node-half.host.spec.ts`、`packages/client/ui-settings-models/tests/provider-form.client.spec.tsx`。

同时完成了仓库 typecheck 与 lint。
