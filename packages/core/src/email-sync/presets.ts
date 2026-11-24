export const EMAIL_PROVIDER_PRESETS = {
  gmail: { label: "Gmail", host: "imap.gmail.com", port: 993, secure: true, note: "Dùng App Password 16 ký tự" },
  outlook: { label: "Outlook / Microsoft 365", host: "outlook.office365.com", port: 993, secure: true, note: "IMAP SSL" },
  hotmail: { label: "Hotmail", host: "outlook.office365.com", port: 993, secure: true, note: "IMAP SSL" },
  fastmail: { label: "Fastmail", host: "imap.fastmail.com", port: 993, secure: true, note: "App Password" },
  yahoo: { label: "Yahoo Mail", host: "imap.mail.yahoo.com", port: 993, secure: true, note: "App Password" },
  apple: { label: "Apple iCloud", host: "imap.mail.me.com", port: 993, secure: true, note: "App-Specific Password" },
  custom: { label: "Custom IMAP", host: "", port: 993, secure: true, note: "Mail server doanh nghiệp riêng" }
} as const
