<!-- 无文字的通用标识：折角剧本页与播放符号结合，名称确定前仅展示图形。 -->
<template>
  <img class="studio-logo" src="/logo.svg" alt="" width="48" height="48" aria-hidden="true" />
</template>
<style scoped>
.studio-logo {
  display: block;
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  border-radius: 15px;
  box-shadow: 0 4px 12px var(--theme-shadow-7963cb20, #7963cb20);
}
@media (max-width: 650px) {
  .studio-logo {
    width: 38px;
    height: 38px;
    border-radius: 12px;
  }
}
</style>
