<script setup>
import { ref, computed, watch } from "vue";
import { useMessage } from 'naive-ui'
import { useScopedI18n } from '@/i18n/app'
import { CloudDownloadRound, ReplyFilled, ForwardFilled, FullscreenRound, ImageRound } from '@vicons/material'
import ShadowHtmlComponent from "./ShadowHtmlComponent.vue";
import AiExtractInfo from "./AiExtractInfo.vue";
import { api } from '../api'
import { getDownloadEmlUrl } from '../utils/email-parser';
import { blockRemoteContent } from '../utils/remote-content-policy';
import { utcToLocalDate } from '../utils';
import { useGlobalState } from '../store';

const { preferShowTextMail, useIframeShowMail, useUTCDate, isDark, autoLoadRemoteImages, jwt, userJwt, adminAuth } = useGlobalState();

const { t } = useScopedI18n('components.MailContentRenderer')
const message = useMessage()

const props = defineProps({
  mail: {
    type: Object,
    required: true
  },
  showEMailTo: {
    type: Boolean,
    default: true
  },
  enableUserDeleteEmail: {
    type: Boolean,
    default: false
  },
  showReply: {
    type: Boolean,
    default: false
  },
  showSaveS3: {
    type: Boolean,
    default: false
  },
  enableMailReadStatus: {
    type: Boolean,
    default: false
  },
  // 回调函数 props
  onDelete: {
    type: Function,
    default: () => { }
  },
  onReply: {
    type: Function,
    default: () => { }
  },
  onForward: {
    type: Function,
    default: () => { }
  },
  onSaveToS3: {
    type: Function,
    default: () => { }
  },
  onUpdateMailReadStatus: {
    type: Function,
    default: () => { }
  }
});

const showTextMail = ref(preferShowTextMail.value);
const showAttachments = ref(false);
const curAttachments = ref([]);
const attachmentLoding = ref(false);
const readStatusUpdating = ref(false);
const showFullscreen = ref(false);

// Per-mail consent, deliberately independent of the global setting: it only
// ever turns true when the user clicks "load images" for this specific mail,
// and resets when a different mail is shown.
const showRemoteImages = ref(false);
watch(() => props.mail.id, () => {
  showRemoteImages.value = false;
});

const processedMail = computed(() => {
  if (autoLoadRemoteImages.value || showRemoteImages.value) {
    return { message: props.mail.message, blocked: 0 };
  }
  const { html, blocked } = blockRemoteContent(props.mail.message);
  return { message: html, blocked };
});

const handleLoadRemoteImages = () => {
  showRemoteImages.value = true;
};

const handleDelete = () => {
  props.onDelete();
};

const handleViewAttachments = () => {
  curAttachments.value = props.mail.attachments;
  showAttachments.value = true;
};

const handleReply = () => {
  props.onReply();
};

const handleForward = () => {
  props.onForward();
};

const handleUpdateMailReadStatus = async () => {
  readStatusUpdating.value = true;
  try {
    await props.onUpdateMailReadStatus();
  } finally {
    readStatusUpdating.value = false;
  }
};


const handleSaveToS3 = async (filename, blob) => {
  attachmentLoding.value = true;
  try {
    await props.onSaveToS3(filename, blob);
  } finally {
    attachmentLoding.value = false;
  }
};

// 退订：地址 JWT(`/api`)、用户 JWT(`/user_api`)、Admin(`/admin`) 是三套鉴权，取当前能读到这封邮件的那一套
const unsubscribeApi = ref('');
const unsubscribeTarget = ref(null);
const unsubscribeLoading = ref(false);

const loadUnsubscribeTarget = async (mailId) => {
  unsubscribeApi.value = '';
  unsubscribeTarget.value = null;
  // 没有对应凭证的接口不必试探，避免无意义的 401
  const endpoints = [
    [jwt.value, '/api/mail'],
    [userJwt.value, '/user_api/mail'],
    [adminAuth.value, '/admin/mail'],
  ]
    .filter(([credential]) => typeof credential === 'string' && credential.trim() !== '' && credential !== 'undefined')
    .map(([, apiBase]) => apiBase);

  for (const apiBase of endpoints) {
    try {
      const res = await api.fetch(`${apiBase}/${mailId}/unsubscribe`, { showLoading: false });
      unsubscribeApi.value = apiBase;
      unsubscribeTarget.value = res?.available ? res : null;
      return;
    } catch (error) {
      // 当前鉴权读不到这封邮件，换另一套再试
    }
  }
};

const handleUnsubscribe = async () => {
  unsubscribeLoading.value = true;
  try {
    const res = await api.fetch(`${unsubscribeApi.value}/${props.mail.id}/unsubscribe`, {
      method: 'POST',
      showLoading: false,
    });
    if (res?.success) message.success(t('unsubscribeSuccess'));
    else message.warning(t('unsubscribeFailed'));
  } catch (error) {
    message.error(t('unsubscribeFailed'));
  } finally {
    unsubscribeLoading.value = false;
  }
};

watch(() => props.mail.id, (mailId) => {
  void loadUnsubscribeTarget(mailId);
}, { immediate: true });

</script>

<template>
  <div class="mail-content-renderer">
    <!-- 邮件信息标签 -->
    <n-space>
      <n-tag type="info">
        ID: {{ mail.id }}
      </n-tag>
      <n-tag type="info">
        {{ utcToLocalDate(mail.created_at, useUTCDate.value) }}
      </n-tag>
      <n-tag type="info">
        FROM: {{ mail.source }}
      </n-tag>
      <n-tag v-if="showEMailTo" type="info">
        TO: {{ mail.address }}
      </n-tag>

      <!-- 操作按钮 -->
      <n-popconfirm v-if="unsubscribeTarget && unsubscribeTarget.url" @positive-click="handleUnsubscribe">
        <template #trigger>
          <n-button size="small" tertiary type="warning" :loading="unsubscribeLoading">
            {{ t('unsubscribe') }}
          </n-button>
        </template>
        {{ t('unsubscribeTip') }}
      </n-popconfirm>
      <n-button v-else-if="unsubscribeTarget" tag="a" target="_blank" size="small" tertiary type="warning"
        :href="unsubscribeTarget.mailto">
        {{ t('unsubscribeByMail') }}
      </n-button>

      <n-popconfirm v-if="enableUserDeleteEmail" @positive-click="handleDelete">
        <template #trigger>
          <n-button tertiary type="error" size="small">{{ t('delete') }}</n-button>
        </template>
        {{ t('deleteMailTip') }}
      </n-popconfirm>

      <n-button v-if="mail.attachments && mail.attachments.length > 0" size="small" tertiary type="info"
        @click="handleViewAttachments">
        {{ t('attachments') }}
      </n-button>

      <n-button v-if="enableMailReadStatus" size="small" tertiary type="info" :loading="readStatusUpdating"
        @click="handleUpdateMailReadStatus">
        {{ mail.is_unread === 1 ? t('markAsRead') : t('markAsUnread') }}
      </n-button>

      <n-button tag="a" target="_blank" tertiary type="info" size="small" :download="mail.id + '.eml'"
        :href="getDownloadEmlUrl(mail.raw)">
        <template #icon>
          <n-icon :component="CloudDownloadRound" />
        </template>
        {{ t('downloadMail') }}
      </n-button>

      <n-button v-if="showReply" size="small" tertiary type="info" @click="handleReply">
        <template #icon>
          <n-icon :component="ReplyFilled" />
        </template>
        {{ t('reply') }}
      </n-button>

      <n-button v-if="showReply" size="small" tertiary type="info" @click="handleForward">
        <template #icon>
          <n-icon :component="ForwardFilled" />
        </template>
        {{ t('forward') }}
      </n-button>

      <n-button size="small" tertiary type="info" @click="showTextMail = !showTextMail">
        {{ showTextMail ? t('showHtmlMail') : t('showTextMail') }}
      </n-button>

      <n-button size="small" tertiary type="info" @click="showFullscreen = true">
        <template #icon>
          <n-icon :component="FullscreenRound" />
        </template>
        {{ t('fullscreen') }}
      </n-button>

    </n-space>

    <!-- 外部资源阻断提示 -->
    <n-alert v-if="processedMail.blocked" type="warning" :show-icon="false" :bordered="false"
      class="remote-images-banner">
      <n-space align="center" justify="space-between">
        <span>{{ t('remoteImagesBlocked', { count: processedMail.blocked }) }}</span>
        <n-button size="tiny" tertiary type="warning" @click="handleLoadRemoteImages">
          <template #icon>
            <n-icon :component="ImageRound" />
          </template>
          {{ t('loadRemoteImages') }}
        </n-button>
      </n-space>
    </n-alert>

    <!-- AI 提取信息 -->
    <AiExtractInfo :metadata="mail.metadata" />

    <!-- 邮件内容 -->
    <div class="mail-content" :class="{ 'dark-mode': isDark }">
      <pre v-if="showTextMail" class="mail-text">{{ mail.text }}</pre>
      <iframe v-else-if="useIframeShowMail" :srcdoc="processedMail.message" class="mail-iframe">
      </iframe>
      <ShadowHtmlComponent v-else :key="mail.id" :htmlContent="processedMail.message" :isDark="isDark" class="mail-html" />
    </div>
  </div>

  <n-drawer v-model:show="showFullscreen" width="100%" placement="bottom" :trap-focus="false" :block-scroll="false"
    style="height: 100vh;">
    <n-drawer-content :title="mail.subject" closable>
      <div class="fullscreen-mail-content" :class="{ 'dark-mode': isDark }">
        <pre v-if="showTextMail" class="mail-text">{{ mail.text }}</pre>
        <iframe v-else-if="useIframeShowMail" :srcdoc="processedMail.message" class="mail-iframe">
        </iframe>
        <ShadowHtmlComponent v-else :key="mail.id" :htmlContent="processedMail.message" :isDark="isDark" class="mail-html" />
      </div>
    </n-drawer-content>
  </n-drawer>

  <!-- 附件模态框 -->
  <n-modal v-model:show="showAttachments" preset="dialog" title="Dialog">
    <template #header>
      <div>{{ t('attachments') }}</div>
    </template>
    <n-spin v-model:show="attachmentLoding">
      <n-list hoverable clickable>
        <n-list-item v-for="row in curAttachments" v-bind:key="row.id">
          <n-thing class="center" :title="row.filename">
            <template #description>
              <n-space>
                <n-tag type="info">
                  Size: {{ row.size }}
                </n-tag>
                <n-button v-if="showSaveS3" @click="handleSaveToS3(row.filename, row.blob)" ghost type="info"
                  size="small">
                  {{ t('saveToS3') }}
                </n-button>
              </n-space>
            </template>
          </n-thing>
          <template #suffix>
            <n-button tag="a" target="_blank" tertiary type="info" size="small" :download="row.filename"
              :href="row.url">
              <n-icon :component="CloudDownloadRound" />
            </n-button>
          </template>
        </n-list-item>
      </n-list>
    </n-spin>
  </n-modal>
</template>

<style scoped>
.mail-content-renderer {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* Let the banner's inner space fill the alert so the button sits on the right. */
.remote-images-banner :deep(.n-space) {
  width: 100%;
}

.mail-content {
  margin-top: 10px;
  flex: 1;
}

.mail-text {
  white-space: pre-wrap;
  word-wrap: break-word;
  margin: 0;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
}

.dark-mode .mail-text {
  color: #e0e0e0;
}

.mail-iframe {
  width: 100%;
  height: 100%;
  border: none;
  min-height: 400px;
}

.dark-mode .mail-iframe {
  background-color: #fff;
}

.mail-html {
  width: 100%;
  height: 100%;
}

.center {
  text-align: center;
}

.fullscreen-mail-content {
  height: calc(100vh - 120px);
  overflow: auto;
}

.fullscreen-mail-content .mail-iframe {
  min-height: calc(100vh - 120px);
}
</style>
