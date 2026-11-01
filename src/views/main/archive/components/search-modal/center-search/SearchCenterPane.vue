<script setup lang="ts">
import SearchFilterMenu from './SearchFilterMenu.vue';
import SearchResultList from './SearchResultList.vue';
import SearchToolbarHeader from './SearchToolbarHeader.vue';
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <!-- 中栏顶部：大尺寸搜索框（内嵌搜索按钮）+ 右侧筛选与预留 SVG 图标 -->
    <SearchToolbarHeader />

    <!-- 点击「筛选」往下伸出的菜单：Header 分为「搜索前」和「搜索后」 -->
    <SearchFilterMenu />

    <!-- 流式搜索结果卡片流（支持懒加载、Shift 连续多选、向左拖拽入磁贴树） -->
    <SearchResultList />
  </section>
</template>
