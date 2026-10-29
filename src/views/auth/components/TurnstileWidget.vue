<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { turnstileBridge } from '@/stores/auth/data-sources/turnstileBridge';

const props = defineProps<{ action: 'login' | 'register' | 'admin_login' }>();
const containerId = `turnstile-slot-${props.action}`;
onMounted(() => { void turnstileBridge.mount(props.action, containerId); });
onBeforeUnmount(() => turnstileBridge.unmount(props.action));
</script>

<template>
  <!-- 仅作为 SDK 挂载点：Turnstile 自带边框与底色，外层不要再加框 -->
  <div :id="containerId" class="flex min-h-[65px] w-full items-center justify-center" />
</template>
