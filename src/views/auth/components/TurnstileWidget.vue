<!--
  ============================================================================
  Turnstile 挂载容器（零 ref、零逻辑）
  ============================================================================
  这个组件故意「什么都没做」：
  · 容器 id 由 action 派生，保证三个页面不会抢同一个 DOM 节点；
  · 真正的 SDK 加载、widget 生命周期、令牌回写全在 turnstileBridge；
  · 外层不要再加边框/底色/内边距，否则会与 SDK 自带卡片形成双框。
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { turnstileBridge } from '@/stores/auth/data-sources/turnstileBridge';

const props = defineProps<{ action: 'login' | 'register' | 'admin_login' }>();
// 容器 id 固定可推导，bridge 用 getElementById 就能找到挂载点
const containerId = `turnstile-slot-${props.action}`;
onMounted(() => { void turnstileBridge.mount(props.action, containerId); });
onBeforeUnmount(() => turnstileBridge.unmount(props.action));
</script>

<template>
  <!-- 仅作为 SDK 挂载点：Turnstile 自带边框与底色，外层不要再加框 -->
  <div :id="containerId" class="flex min-h-[65px] w-full items-center justify-center" />
</template>
