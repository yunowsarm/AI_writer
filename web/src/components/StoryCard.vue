<script setup>
/** 可复用的模板 / 广场卡片：仅负责展示与抛出操作事件。 */
import { coverClass, genreIcon } from '../shared/format'
import ReactionIcon from './ReactionIcon.vue'
import ContentMetricIcon from './ContentMetricIcon.vue'

// item 提供标题、题材和摘要；type 控制展示场景，点击行为由父页面接收事件后处理。
defineProps({
  item: Object,
  type: { type: String, default: 'template' },
  favoritePending: Boolean,
  likePending: Boolean
})
// open 打开详情，apply 套用模板，favorite / like 切换互动；组件本身不发送业务请求。
defineEmits(['open', 'apply', 'favorite', 'like'])
</script>
<template>
  <article class="template-card" :class="{ 'is-template': type === 'template' }">
    <button class="cover" :class="coverClass(item.genre)" @click="$emit('open', item)">
      <span class="cover-label">{{ type === 'template' ? 'STORY TEMPLATE' : 'ORIGINAL STORY' }}</span>
      <span class="cover-symbol" aria-hidden="true">
        <el-icon><component :is="genreIcon(item.genre)" /></el-icon>
      </span>
      <h3>{{ item.title }}</h3>
      <span class="cover-en">YOUR STORY STARTS HERE</span>
      <span class="cover-chip" :title="type === 'template' && item.kind !== 'official' ? (item.visibility === 'public' ? '其他用户可收藏和套用' : '个人模板仅自己可见') : ''">
        {{ type === 'template' ? (item.kind === 'official' ? '官方模板' : item.visibility === 'public' ? '个人模板 · 公开' : '个人模板 · 私有') : '原创剧本' }}
      </span>
    </button>
    <div class="template-info">
      <h3>
        <span class="card-title-text" :title="item.title">{{ item.title }}</span>
        <span class="genre-badge">{{ item.genre }}</span>
      </h3>
      <p class="card-desc">{{ item.description || item.synopsis || '这个故事，等待你的发现。' }}</p>
      <div class="template-foot">
        <span>{{ type === 'template' ? item.uses + ' 次使用' : 'by ' + item.author }} · {{ item.params?.episodes || item.episode_count }} 集</span>
        <button
          class="icon-button favorite-button"
          :class="{ 'is-active': item.favorited }"
          :title="item.favorited ? '取消收藏' : '收藏'"
          :aria-label="item.favorited ? '取消收藏' : '收藏'"
          :aria-pressed="!!item.favorited"
          :disabled="favoritePending"
          @click="$emit('favorite', item)">
          <ReactionIcon kind="favorite" :active="!!item.favorited" />
        </button>
      </div>
      <div v-if="type === 'script'" class="community-actions">
        <button
          class="reaction-button like-button"
          :class="{ 'is-active': item.liked }"
          :title="item.liked ? '取消点赞' : '点赞'"
          :aria-label="item.liked ? '取消点赞' : '点赞'"
          :aria-pressed="!!item.liked"
          :disabled="likePending"
          @click="$emit('like', item)">
          <ReactionIcon kind="like" :active="!!item.liked" />
          {{ item.likes }}
        </button>
        <span :aria-label="'评论 ' + item.comments + ' 条'" title="评论数">
          <ContentMetricIcon kind="comment" />
          {{ item.comments }}
        </span>
        <span :aria-label="'浏览 ' + item.views + ' 次'" title="浏览量">
          <ContentMetricIcon kind="view" />
          {{ item.views }}
        </span>
        <button @click="$emit('open', item)">
          阅读剧本
          <el-icon class="inline-icon" aria-hidden="true"><TopRight /></el-icon>
        </button>
      </div>
      <el-button v-else class="use-template" @click="$emit('apply', item)">
        使用此模板
        <el-icon class="inline-icon" aria-hidden="true"><TopRight /></el-icon>
      </el-button>
    </div>
  </article>
</template>

<style scoped>
/* 卡片以相同的封面、标题和摘要区域排版，底部操作随容器对齐，不受简介长短影响。 */
.template-card.is-template {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
}
.is-template .cover {
  flex-shrink: 0;
  width: 100%;
}
.is-template .template-info {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  gap: 0;
}
.template-info h3 {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.template-info h3 .card-title-text {
  flex: 1;
  min-width: 0;
  padding: 0;
  background: none;
  color: inherit;
  font-size: inherit;
  font-weight: inherit;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.template-info h3 .genre-badge {
  flex-shrink: 0;
}
.is-template .template-info h3 {
  min-height: 28px;
  margin-bottom: 0;
}
.is-template .template-info .card-desc {
  line-height: 1.8;
  height: 54px;
  min-height: 54px;
  margin: 10px 0 18px;
  -webkit-line-clamp: 2;
}
.is-template .template-foot {
  margin-top: auto;
  padding-top: 4px;
  padding-bottom: 16px;
}
.is-template .use-template {
  margin-top: 0;
  width: 100%;
  min-height: 42px;
}
</style>
