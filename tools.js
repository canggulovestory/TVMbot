// tools.js — Anthropic Tool Definitions for TVMbot
// 25 tools covering Gmail, Calendar, Drive, Docs, Sheets, Cleaning, Marketing, Memory

const TOOLS = [
  {
    name: "gmail_list_messages",
    description: "List recent emails from Gmail. Can filter by search query.",
    input_schema: {
      type: "object",
      properties: {
        maxResults: { type: "number", description: "Max emails to return (default 10)" },
        query: { type: "string", description: "Gmail search query e.g. 'from:guest@email.com' or 'subject:booking'" }
      }
    }
  },
  {
    name: "gmail_read_message",
    description: "Read the full content of a specific email by its message ID.",
    input_schema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Gmail message ID from gmail_list_messages" }
      },
      required: ["messageId"]
    }
  },
  {
    name: "gmail_send_message",
    description: "Send an email via Gmail. Use for booking confirmations, guest communication, owner reports.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body text (plain text or HTML)" }
      },
      required: ["to", "subject", "body"]
    }
  },
  {
    name: "gmail_get_flagged",
    description: "Get starred or important emails that need attention.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "calendar_get_events",
    description: "List upcoming calendar events. Filter by date range.",
    input_schema: {
      type: "object",
      properties: {
        maxResults: { type: "number", description: "Max events to return (default 10)" },
        timeMin: { type: "string", description: "Start date-time ISO 8601 e.g. 2024-01-01T00:00:00Z" },
        timeMax: { type: "string", description: "End date-time ISO 8601" }
      }
    }
  },
  {
    name: "calendar_check_availability",
    description: "Check if a time slot is available (no overlapping events).",
    input_schema: {
      type: "object",
      properties: {
        startTime: { type: "string", description: "Check-in date-time ISO 8601" },
        endTime: { type: "string", description: "Check-out date-time ISO 8601" }
      },
      required: ["startTime", "endTime"]
    }
  },
  {
    name: "calendar_create_event",
    description: "Create a new calendar event for villa bookings, cleaning, inspections.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title e.g. 'John Smith @ Villa Canggu'" },
        startTime: { type: "string", description: "Start ISO 8601 datetime" },
        endTime: { type: "string", description: "End ISO 8601 datetime" },
        description: { type: "string", description: "Event description/notes" },
        attendees: { type: "array", items: { type: "string" }, description: "List of email addresses to invite" }
      },
      required: ["summary", "startTime", "endTime"]
    }
  },
  {
    name: "drive_search_files",
    description: "Search for files in Google Drive by name or keyword.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query e.g. 'passport' or 'contract'" },
        maxResults: { type: "number", description: "Max files to return (default 10)" }
      }
    }
  },
  {
    name: "drive_find_passport",
    description: "Find passport or ID documents for a specific guest in Google Drive.",
    input_schema: {
      type: "object",
      properties: {
        guestName: { type: "string", description: "Guest full name to search for" }
      },
      required: ["guestName"]
    }
  },
  {
    name: "drive_get_recent",
    description: "List recently modified files in Google Drive.",
    input_schema: {
      type: "object",
      properties: {
        maxResults: { type: "number", description: "Number of recent files (default 10)" }
      }
    }
  },
  {
    name: "drive_create_folder",
    description: "Create a new folder in Google Drive for organizing guest files, contracts, etc.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Folder name" },
        parentId: { type: "string", description: "Parent folder ID (optional)" }
      },
      required: ["name"]
    }
  },
  {
    name: "docs_create_document",
    description: "Create a new Google Doc with specified content.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Document title" },
        content: { type: "string", description: "Document content/body text" }
      },
      required: ["title"]
    }
  },
  {
    name: "docs_read_document",
    description: "Read the content of an existing Google Doc.",
    input_schema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Google Doc ID from URL" }
      },
      required: ["documentId"]
    }
  },
  {
    name: "docs_update_document",
    description: "Update/append content to an existing Google Doc.",
    input_schema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Google Doc ID" },
        content: { type: "string", description: "New content to insert/append" }
      },
      required: ["documentId", "content"]
    }
  },
  {
    name: "docs_create_contract",
    description: "Generate a complete villa rental contract as a Google Doc. Creates the doc, fills in all guest and villa details, and returns a link.",
    input_schema: {
      type: "object",
      properties: {
        guestName: { type: "string", description: "Guest full name" },
        villaName: { type: "string", description: "Villa name" },
        checkIn: { type: "string", description: "Check-in date YYYY-MM-DD" },
        checkOut: { type: "string", description: "Check-out date YYYY-MM-DD" },
        price: { type: "number", description: "Total rental price in USD" },
        extras: { type: "string", description: "Extra services included (airport transfer, breakfast, etc.)" },
        guestEmail: { type: "string", description: "Guest email address" }
      },
      required: ["guestName", "villaName", "checkIn", "checkOut", "price"]
    }
  },
  {
    name: "sheets_read_data",
    description: "Read data from a Google Spreadsheet. Returns rows and columns.",
    input_schema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Google Sheets ID from URL" },
        range: { type: "string", description: "Cell range e.g. 'Sheet1' or 'Sheet1!A1:E20'" }
      },
      required: ["spreadsheetId"]
    }
  },
  {
    name: "sheets_write_data",
    description: "Write/overwrite data to specific cells in a Google Spreadsheet.",
    input_schema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Google Sheets ID" },
        range: { type: "string", description: "Cell range e.g. 'Sheet1!A1'" },
        values: { type: "array", description: "2D array of values [[row1col1, row1col2], [row2col1,...]]" }
      },
      required: ["spreadsheetId", "range", "values"]
    }
  },
  {
    name: "sheets_append_row",
    description: "Append a new row to the end of a Google Spreadsheet sheet.",
    input_schema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "Google Sheets ID" },
        sheetName: { type: "string", description: "Sheet/tab name (default Sheet1)" },
        values: { type: "array", description: "Array of values for the new row [col1, col2, col3...]" }
      },
      required: ["spreadsheetId", "values"]
    }
  },
  {
    name: "cleaning_generate_schedule",
    description: "Generate a weekly cleaning and housekeeping schedule based on check-ins and check-outs.",
    input_schema: {
      type: "object",
      properties: {
        checkIns: { type: "array", items: { type: "string" }, description: "List of check-in dates YYYY-MM-DD" },
        checkOuts: { type: "array", items: { type: "string" }, description: "List of check-out dates YYYY-MM-DD" },
        villaName: { type: "string", description: "Villa name" }
      }
    }
  },
  {
    name: "marketing_generate_content",
    description: "Generate marketing content for villa promotion: Instagram captions, Airbnb descriptions, email promotions, welcome letters.",
    input_schema: {
      type: "object",
      properties: {
        villaName: { type: "string", description: "Villa name" },
        contentType: { type: "string", enum: ["instagram", "facebook", "airbnb", "email_promo", "welcome_letter", "review_request"], description: "Type of content to generate" },
        details: { type: "object", description: "Additional details: location, features, special offer, guest name, etc." }
      },
      required: ["villaName", "contentType"]
    }
  },
  {
    name: "get_owner_profile",
    description: "Retrieve the owner profile, villa details, and upcoming bookings from memory.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "save_note",
    description: "Save an important note or business information to agent memory for future reference.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Note title/subject" },
        body: { type: "string", description: "Note content" },
        tags: { type: "string", description: "Comma-separated tags e.g. 'guest,booking,important'" }
      },
      required: ["title", "body"]
    }
  },
  // ── Finance Tools ─────────────────────────────────────────────────────────
  {
    name: "finance_log_payment",
    description: "Record a payment received from a guest (income). Logs to TVMbot memory and Google Sheets ledger. Use for booking deposits, full payments, balance payments.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "What this payment is for e.g. 'Deposit for Villa Canggu — John Smith'" },
        amount: { type: "number", description: "Payment amount" },
        currency: { type: "string", description: "Currency code: USD, IDR, EUR, AUD (default USD)" },
        guest_name: { type: "string", description: "Guest name" },
        villa_name: { type: "string", description: "Villa name" },
        payment_method: { type: "string", description: "How paid: bank_transfer, cash, credit_card, wise, paypal" },
        status: { type: "string", enum: ["paid", "pending", "partial"], description: "Payment status" },
        date: { type: "string", description: "Payment date YYYY-MM-DD (defaults to today)" },
        booking_id: { type: "number", description: "Linked booking ID if available" },
        reference: { type: "string", description: "Bank reference or transaction ID" }
      },
      required: ["description", "amount"]
    }
  },
  {
    name: "finance_log_expense",
    description: "Record a business expense (cleaning, maintenance, staff, utilities, supplies, etc.). Logs to TVMbot memory and Google Sheets ledger.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "What the expense is for e.g. 'Weekly cleaning — Villa Ubud'" },
        amount: { type: "number", description: "Expense amount" },
        currency: { type: "string", description: "Currency code" },
        category: { type: "string", enum: ["cleaning", "maintenance", "staff", "utilities", "supplies", "marketing", "transport", "food", "commission", "tax", "insurance", "other"], description: "Expense category" },
        villa_name: { type: "string", description: "Which villa this expense relates to" },
        payment_method: { type: "string", description: "How paid" },
        date: { type: "string", description: "Expense date YYYY-MM-DD" },
        reference: { type: "string", description: "Receipt or reference number" }
      },
      required: ["description", "amount", "category"]
    }
  },
  {
    name: "finance_get_report",
    description: "Generate a Profit & Loss (P&L) financial report for a given time period. Shows total income, total expenses, net profit, margin, and breakdown by category.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["this_month", "last_month", "this_year", "last_30_days", "last_90_days", "custom"], description: "Report period" },
        start_date: { type: "string", description: "Start date YYYY-MM-DD (required if period=custom)" },
        end_date: { type: "string", description: "End date YYYY-MM-DD (required if period=custom)" },
        villa_name: { type: "string", description: "Filter by specific villa (optional)" }
      },
      required: ["period"]
    }
  },
  {
    name: "finance_get_outstanding",
    description: "List all unpaid or partially paid bookings/invoices. Shows who owes money, how much, and for which villa.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "finance_generate_invoice",
    description: "Generate a professional PDF invoice for a guest and optionally send it by email. Creates invoice with your company branding, line items, taxes, and totals.",
    input_schema: {
      type: "object",
      properties: {
        guest_name: { type: "string", description: "Guest full name" },
        guest_email: { type: "string", description: "Guest email for sending" },
        villa_name: { type: "string", description: "Villa name" },
        line_items: {
          type: "array",
          description: "Invoice line items",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              quantity: { type: "number" },
              unit_price: { type: "number" }
            }
          }
        },
        currency: { type: "string", description: "Currency code (default USD)" },
        tax_rate: { type: "number", description: "Tax percentage e.g. 11 for 11% (default 0)" },
        due_date: { type: "string", description: "Payment due date YYYY-MM-DD" },
        notes: { type: "string", description: "Payment instructions or notes on invoice" },
        send_email: { type: "boolean", description: "Whether to email the invoice to the guest" },
        booking_id: { type: "number", description: "Link to booking ID" }
      },
      required: ["guest_name", "line_items"]
    }
  },
  {
    name: "finance_update_bank_balance",
    description: "Update the current balance of a bank account. Use when you check your bank and want TVMbot to remember the current amounts. Can also add a new account.",
    input_schema: {
      type: "object",
      properties: {
        account_name: { type: "string", description: "Account nickname e.g. 'BCA Main', 'Wise USD', 'PayPal'" },
        bank: { type: "string", description: "Bank name e.g. BCA, Mandiri, Wise, PayPal" },
        balance: { type: "number", description: "Current balance amount" },
        currency: { type: "string", description: "Account currency e.g. IDR, USD" },
        account_number: { type: "string", description: "Last 4 digits or masked account number (optional)" },
        notes: { type: "string", description: "Any notes about this account" }
      },
      required: ["account_name", "balance"]
    }
  },
  {
    name: "finance_get_bank_balances",
    description: "Show the current balance of all bank accounts that have been registered with TVMbot. Also shows total across all accounts per currency.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "finance_get_transactions",
    description: "List recent financial transactions (income and expenses). Can filter by type, villa, or month.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["income", "expense", "all"], description: "Filter by income or expense" },
        villa_name: { type: "string", description: "Filter by villa name" },
        month: { type: "string", description: "Filter by month YYYY-MM e.g. 2026-03" },
        limit: { type: "number", description: "Number of records to return (default 20)" }
      }
    }
  },
  {
    name: "finance_mark_invoice_paid",
    description: "Mark an invoice as paid and optionally record the payment in the transactions ledger.",
    input_schema: {
      type: "object",
      properties: {
        invoice_number: { type: "string", description: "Invoice number e.g. INV-2026-001" },
        payment_method: { type: "string", description: "How it was paid" },
        reference: { type: "string", description: "Bank reference or transaction ID" }
      },
      required: ["invoice_number"]
    }
  },
  {
    name: "drive_read_contract",
    description: "Read and extract the full text content of a PDF or DOCX contract file stored in Google Drive. Also works with Google Docs. Use this to analyse contract terms, find dates, extract guest details, check clauses, compare documents, or answer questions about any file.",
    input_schema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "Google Drive file ID (from URL or drive_search_files result)" },
        fileName: { type: "string", description: "Optional file name for display purposes" }
      },
      required: ["fileId"]
    }
  },
  {
    name: "drive_scan_folder",
    description: "Scan an entire Google Drive folder and read all PDF and DOCX contract files found inside it. Returns extracted text from every file. Use this to audit all contracts, find expiring leases, extract all guest names/dates, or do bulk analysis across many documents.",
    input_schema: {
      type: "object",
      properties: {
        folderId: { type: "string", description: "Google Drive folder ID to scan" },
        maxFiles: { type: "number", description: "Max files to read (default 10, max 20)" },
        fileTypes: { type: "string", description: "Filter by type: 'pdf', 'docx', or 'all' (default 'all')" }
      },
      required: ["folderId"]
    }
  },
  {
    name: "notion_get_pages",
    description: "Get pages from Notion workspace (if Notion is connected).",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "notion_create_page",
    description: "Create a new page in a Notion database.",
    input_schema: {
      type: "object",
      properties: {
        databaseId: { type: "string", description: "Notion database ID" },
        properties: { type: "object", description: "Page properties as key-value pairs" },
        content: { type: "string", description: "Page body content" }
      },
      required: ["databaseId"]
    }
  }
];

module.exports = TOOLS;
