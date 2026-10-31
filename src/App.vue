<!--
  ============================================================================
  根组件
  ============================================================================
  整个应用只有这一层是「纯路由出口」：
    - 真正的页面骨架在 src/views/auth/AuthLayout.vue（鉴权域）、
      src/views/layout/AppLayout.vue（工作区）、src/views/admin/AdminLayout.vue（管理域）；
    - 根组件不持有任何状态，也不做任何布局，因此永远保持空 script。
-->
<script setup lang="ts">
// 故意留空：根组件不承载逻辑，所有业务状态都在 Pinia Store，页面骨架在 Layout 组件。
</script>

<template>
  <!-- 当前 URL 命中的页面就地渲染在这里 -->
  <RouterView />
</template>
