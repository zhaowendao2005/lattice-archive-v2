<script setup lang="ts">
</script>

<template>
  <!-- 管理域外壳：与应用区同底色，内容居中且独立滚动 -->
  <div class="h-dvh w-full overflow-hidden bg-background pt-[var(--safe-top)] pb-[var(--safe-bottom)]">
    <div class="h-full overflow-y-auto">
      <RouterView />
    </div>
  </div>
</template>