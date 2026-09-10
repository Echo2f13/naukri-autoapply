'use strict';

/**
 * Scoped DOM selectors for WhatsApp Web authentication, channels, and message scraping.
 */
module.exports = {
    // Authentication & QR Code
    qrCodeCanvas: 'canvas[aria-label*="Scan" i], div[data-testid="qrcode"] canvas, div[data-ref] canvas',
    qrCodeContainer: 'div[data-testid="qrcode"], div[data-ref], [data-testid="link-device-wrapper"]',
    
    // Authenticated UI Indicators
    paneSide: 'div#pane-side, [data-testid="chat-list"]',
    channelsTabButton: 'button[aria-label*="Channels" i], span[data-icon="channels-outline"], span[data-icon="newsletter-outline"]',
    searchBox: 'div[contenteditable="true"][data-tab="3"], div[title="Search input textbox"], div[data-testid="chat-list-search"]',

    // Public Channel Landing Page (whatsapp.com/channel/...)
    channelPreviewTitle: 'h3, [class*="title"], h1',
    openInWebButton: 'a:has-text("View channel"), a:has-text("Open in WhatsApp"), a[href*="web.whatsapp.com"]',
    viewChannelButton: 'button:has-text("View channel"), a:has-text("View channel")',

    // Channel / Chat Conversation Pane
    conversationPanel: 'div[data-testid="conversation-panel-wrapper"], div#main',
    channelHeader: 'header[data-testid="conversation-header"], div[data-testid="channel-header"]',
    messageBubbles: 'div.message-in, div[role="row"], div[data-id], div[class*="message-in"]',
    messageText: '.selectable-text, span._ao3e, [class*="selectable-text"], [class*="copyable-text"] span',
    messageTimestamp: '[data-testid="msg-meta"] span, span[data-testid*="timestamp"], span._ao3u',
    
    // Status / Updates
    emptyChatPrompt: 'div[data-testid="empty-chat-prompt"]'
};
