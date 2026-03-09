import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

export default withMermaid(
  defineConfig({
    lang: 'zh-CN',
    title: 'Metapi 文档',
    description: '面向普通用户的 Metapi 使用文档',
    cleanUrls: true,
    lastUpdated: true,
    ignoreDeadLinks: true,
    themeConfig: {
      siteTitle: 'Metapi Docs',
      logo: '/logos/logo-icon-512.png',
      nav: [
        { text: '首页', link: '/' },
        { text: '快速开始', link: '/getting-started' },
        { text: '上游接入', link: '/upstream-integration' },
        { text: '下游接入', link: '/client-integration' },
        { text: 'FAQ / 排错', link: '/faq' },
        { text: '项目主页', link: 'https://github.com/cita-777/metapi' },
      ],
      sidebar: [
        {
          text: '开始使用',
          items: [
            { text: '文档首页', link: '/' },
            { text: '快速开始', link: '/getting-started' },
          ],
        },
        {
          text: '上游接入',
          items: [
            { text: '上游接入总览', link: '/upstream-integration' },
            { text: 'New API', link: '/upstream/new-api' },
            { text: 'Sub2API', link: '/upstream/sub2api' },
            { text: 'AnyRouter', link: '/upstream/anyrouter' },
            { text: 'One API', link: '/upstream/one-api' },
            { text: 'OneHub', link: '/upstream/onehub' },
            { text: 'DoneHub', link: '/upstream/donehub' },
            { text: 'Veloera', link: '/upstream/veloera' },
          ],
        },
        {
          text: '下游接入',
          items: [
            { text: '下游接入', link: '/client-integration' },
          ],
        },
        {
          text: 'FAQ 与排错',
          items: [
            { text: 'FAQ / 排错', link: '/faq' },
          ],
        },
        {
          text: '高级与自托管',
          items: [
            { text: '自托管部署与反向代理', link: '/deployment' },
            { text: '运行配置与部署级配置', link: '/configuration' },
            { text: '运维与维护', link: '/operations' },
          ],
        },
        {
          text: '文档维护',
          items: [
            { text: '文档维护与贡献', link: '/README' },
            { text: '目录规范', link: '/project-structure' },
            { text: 'FAQ/教程贡献规范', link: '/community/faq-tutorial-guidelines' },
          ],
        },
      ],
      socialLinks: [
        { icon: 'github', link: 'https://github.com/cita-777/metapi' },
      ],
      outline: {
        level: [2, 3],
      },
      footer: {
        message: 'MIT Licensed',
        copyright: 'Copyright (c) 2026 Metapi Contributors',
      },
      search: {
        provider: 'local',
      },
    },
  }),
);
