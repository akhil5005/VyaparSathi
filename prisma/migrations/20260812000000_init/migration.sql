-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'MANAGER', 'BILLING_STAFF', 'ACCOUNTANT', 'VIEWER');

-- CreateEnum
CREATE TYPE "PartyType" AS ENUM ('CUSTOMER', 'SUPPLIER', 'BOTH');

-- CreateEnum
CREATE TYPE "GstRegistrationType" AS ENUM ('REGULAR', 'COMPOSITION', 'UNREGISTERED', 'CONSUMER', 'SEZ_WITH_PAYMENT', 'SEZ_WITHOUT_PAYMENT', 'EXPORT');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('SALES_INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE', 'DELIVERY_CHALLAN', 'PURCHASE_INVOICE', 'PURCHASE_RETURN', 'PAYMENT_RECEIPT', 'PAYMENT_VOUCHER', 'QUOTATION');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SupplyType" AS ENUM ('INTRA_STATE', 'INTER_STATE');

-- CreateEnum
CREATE TYPE "NoteType" AS ENUM ('CREDIT_NOTE', 'DEBIT_NOTE');

-- CreateEnum
CREATE TYPE "NoteReason" AS ENUM ('SALES_RETURN', 'PURCHASE_RETURN', 'RATE_DIFFERENCE', 'QUANTITY_SHORTAGE', 'DAMAGED_GOODS', 'POST_SALE_DISCOUNT', 'CORRECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('RECEIPT', 'PAYMENT');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('CASH', 'UPI', 'CHEQUE', 'BANK_TRANSFER', 'NEFT_RTGS', 'CARD', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ChequeStatus" AS ENUM ('PENDING', 'DEPOSITED', 'CLEARED', 'BOUNCED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('OPENING', 'PURCHASE_IN', 'SALE_OUT', 'SALES_RETURN_IN', 'PURCHASE_RETURN_OUT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DAMAGE_OUT');

-- CreateEnum
CREATE TYPE "LedgerVoucherType" AS ENUM ('OPENING_BALANCE', 'SALES_INVOICE', 'PURCHASE_INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE', 'RECEIPT', 'PAYMENT', 'CHEQUE_BOUNCE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "EwayBillStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'GENERATED', 'PART_B_PENDING', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TransportMode" AS ENUM ('ROAD', 'RAIL', 'AIR', 'SHIP');

-- CreateEnum
CREATE TYPE "PrinterConnection" AS ENUM ('USB', 'NETWORK', 'BLUETOOTH', 'SYSTEM');

-- CreateEnum
CREATE TYPE "PaperWidth" AS ENUM ('MM_58', 'MM_80', 'A4', 'A5');

-- CreateTable
CREATE TABLE "businesses" (
    "id" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT,
    "gstin" VARCHAR(15) NOT NULL,
    "stateCode" VARCHAR(2) NOT NULL,
    "stateName" TEXT NOT NULL,
    "pan" VARCHAR(10),
    "gstRegistrationType" "GstRegistrationType" NOT NULL DEFAULT 'REGULAR',
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "pincode" VARCHAR(6) NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "bankName" TEXT,
    "bankAccountNumber" TEXT,
    "bankIfsc" TEXT,
    "upiId" TEXT,
    "logoUrl" TEXT,
    "invoiceTerms" TEXT,
    "invoiceFooter" TEXT,
    "fyStartMonth" INTEGER NOT NULL DEFAULT 4,
    "hsnDigits" INTEGER NOT NULL DEFAULT 4,
    "ewayBillThreshold" DECIMAL(14,2) NOT NULL DEFAULT 50000,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'BILLING_STAFF',
    "passwordHash" TEXT NOT NULL,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "emailVerifiedAt" TIMESTAMP(3),
    "phoneVerifiedAt" TIMESTAMP(3),
    "totpSecret" TEXT,
    "totpEnabledAt" TIMESTAMP(3),
    "recoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIp" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "replacedBySessionId" TEXT,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "deviceName" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "identifier" TEXT NOT NULL,
    "successful" BOOLEAN NOT NULL,
    "failReason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parties" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "legalName" TEXT,
    "partyType" "PartyType" NOT NULL DEFAULT 'CUSTOMER',
    "gstin" VARCHAR(15),
    "gstRegistrationType" "GstRegistrationType" NOT NULL DEFAULT 'UNREGISTERED',
    "pan" VARCHAR(10),
    "phone" TEXT,
    "alternatePhone" TEXT,
    "whatsappNumber" TEXT,
    "email" TEXT,
    "contactPerson" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "stateCode" VARCHAR(2) NOT NULL,
    "stateName" TEXT,
    "pincode" VARCHAR(6),
    "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "openingBalanceDate" TIMESTAMP(3),
    "creditLimit" DECIMAL(14,2),
    "creditDays" INTEGER,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "party_balances" (
    "partyId" TEXT NOT NULL,
    "currentBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lastEntryAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "party_balances_pkey" PRIMARY KEY ("partyId")
);

-- CreateTable
CREATE TABLE "party_rates" (
    "id" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "rate" DECIMAL(14,4) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "party_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "uqc" VARCHAR(8) NOT NULL,
    "allowDecimal" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hsn_codes" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" VARCHAR(8) NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hsn_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hsn_tax_rates" (
    "id" TEXT NOT NULL,
    "hsnCodeId" TEXT NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL,
    "cessRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hsn_tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliasNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sku" TEXT,
    "brand" TEXT,
    "description" TEXT,
    "hsnCodeId" TEXT NOT NULL,
    "gsm" INTEGER,
    "sheetSize" TEXT,
    "sheetsPerReam" INTEGER,
    "weightPerBaseUnitKg" DECIMAL(10,4),
    "baseUnitId" TEXT NOT NULL,
    "defaultSaleRate" DECIMAL(14,4),
    "defaultPurchaseRate" DECIMAL(14,4),
    "defaultSaleUnitId" TEXT,
    "defaultPurchaseUnitId" TEXT,
    "reorderLevel" DECIMAL(14,3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_units" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "conversionToBase" DECIMAL(16,6) NOT NULL,
    "isPurchaseDefault" BOOLEAN NOT NULL DEFAULT false,
    "isSalesDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_stocks" (
    "productId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "quantityOnHand" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "avgCostPerBaseUnit" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "lastMovementAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_stocks_pkey" PRIMARY KEY ("productId")
);

-- CreateTable
CREATE TABLE "number_sequences" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "financialYear" VARCHAR(7) NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "suffix" TEXT NOT NULL DEFAULT '',
    "padding" INTEGER NOT NULL DEFAULT 4,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "number_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_invoices" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "invoiceNumber" VARCHAR(16),
    "financialYear" VARCHAR(7) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "partyId" TEXT NOT NULL,
    "partyName" TEXT NOT NULL,
    "partyGstin" VARCHAR(15),
    "partyAddress" TEXT,
    "partyStateCode" VARCHAR(2) NOT NULL,
    "partyPhone" TEXT,
    "supplyType" "SupplyType" NOT NULL,
    "placeOfSupply" VARCHAR(2) NOT NULL,
    "reverseCharge" BOOLEAN NOT NULL DEFAULT false,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalDiscount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxableValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalCgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalSgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalIgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalCess" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "freightCharges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherCharges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amountInWords" TEXT,
    "amountPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "costOfGoods" DECIMAL(14,2),
    "notes" TEXT,
    "transportName" TEXT,
    "vehicleNumber" TEXT,
    "createdById" TEXT NOT NULL,
    "createdViaVoice" BOOLEAN NOT NULL DEFAULT false,
    "voiceSessionId" TEXT,
    "issuedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "printedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_invoice_items" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "hsnCode" VARCHAR(8) NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitId" TEXT NOT NULL,
    "unitName" TEXT NOT NULL,
    "uqc" VARCHAR(8) NOT NULL,
    "conversionToBase" DECIMAL(16,6) NOT NULL,
    "baseQuantity" DECIMAL(14,3) NOT NULL,
    "rate" DECIMAL(14,4) NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxableValue" DECIMAL(14,2) NOT NULL,
    "cgstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sgstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cessRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cessAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "costPerBaseUnit" DECIMAL(14,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_invoices" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "purchaseNumber" VARCHAR(20) NOT NULL,
    "supplierInvoiceNumber" TEXT NOT NULL,
    "supplierInvoiceDate" TIMESTAMP(3) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "partyId" TEXT NOT NULL,
    "partyName" TEXT NOT NULL,
    "partyGstin" VARCHAR(15),
    "partyStateCode" VARCHAR(2) NOT NULL,
    "supplyType" "SupplyType" NOT NULL,
    "reverseCharge" BOOLEAN NOT NULL DEFAULT false,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalDiscount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxableValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalCgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalSgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalIgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalCess" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "freightCharges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherCharges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amountPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "itcEligible" BOOLEAN NOT NULL DEFAULT true,
    "itcClaimed" BOOLEAN NOT NULL DEFAULT false,
    "itcClaimedIn" VARCHAR(7),
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_invoice_items" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "hsnCode" VARCHAR(8) NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitId" TEXT NOT NULL,
    "unitName" TEXT NOT NULL,
    "uqc" VARCHAR(8) NOT NULL,
    "conversionToBase" DECIMAL(16,6) NOT NULL,
    "baseQuantity" DECIMAL(14,3) NOT NULL,
    "rate" DECIMAL(14,4) NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxableValue" DECIMAL(14,2) NOT NULL,
    "cgstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sgstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cessRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cessAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "landedCostPerBaseUnit" DECIMAL(14,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_debit_notes" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "noteNumber" VARCHAR(16) NOT NULL,
    "financialYear" VARCHAR(7) NOT NULL,
    "noteType" "NoteType" NOT NULL,
    "reason" "NoteReason" NOT NULL,
    "reasonNote" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "noteDate" TIMESTAMP(3) NOT NULL,
    "partyId" TEXT NOT NULL,
    "partyName" TEXT NOT NULL,
    "partyGstin" VARCHAR(15),
    "partyStateCode" VARCHAR(2) NOT NULL,
    "againstSalesInvoiceId" TEXT,
    "againstPurchaseInvoiceId" TEXT,
    "originalInvoiceNumber" TEXT,
    "originalInvoiceDate" TIMESTAMP(3),
    "supplyType" "SupplyType" NOT NULL,
    "taxableValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalCgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalSgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalIgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalCess" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "affectsStock" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_debit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_debit_note_items" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "hsnCode" VARCHAR(8) NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitId" TEXT NOT NULL,
    "unitName" TEXT NOT NULL,
    "uqc" VARCHAR(8) NOT NULL,
    "conversionToBase" DECIMAL(16,6) NOT NULL,
    "baseQuantity" DECIMAL(14,3) NOT NULL,
    "rate" DECIMAL(14,4) NOT NULL,
    "taxableValue" DECIMAL(14,2) NOT NULL,
    "cgstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cgstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sgstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cessRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cessAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_debit_note_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "voucherNumber" VARCHAR(20) NOT NULL,
    "direction" "PaymentDirection" NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "partyId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "referenceNumber" TEXT,
    "bankName" TEXT,
    "notes" TEXT,
    "chequeId" TEXT,
    "unallocatedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "recordedById" TEXT NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "reversedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "salesInvoiceId" TEXT,
    "purchaseInvoiceId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cheques" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "direction" "PaymentDirection" NOT NULL,
    "chequeNumber" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "branchName" TEXT,
    "chequeDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "ChequeStatus" NOT NULL DEFAULT 'PENDING',
    "depositedAt" TIMESTAMP(3),
    "clearedAt" TIMESTAMP(3),
    "bouncedAt" TIMESTAMP(3),
    "bounceReason" TEXT,
    "bounceCharges" DECIMAL(14,2),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cheques_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "voucherType" "LedgerVoucherType" NOT NULL,
    "voucherId" TEXT,
    "voucherNumber" TEXT,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "runningBalance" DECIMAL(14,2) NOT NULL,
    "narration" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "movementType" "StockMovementType" NOT NULL,
    "movementDate" TIMESTAMP(3) NOT NULL,
    "baseQuantity" DECIMAL(14,3) NOT NULL,
    "ratePerBaseUnit" DECIMAL(14,4),
    "balanceAfter" DECIMAL(14,3) NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "referenceNumber" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eway_bills" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "salesInvoiceId" TEXT NOT NULL,
    "status" "EwayBillStatus" NOT NULL DEFAULT 'PENDING',
    "ewbNumber" VARCHAR(12),
    "ewbDate" TIMESTAMP(3),
    "validUpto" TIMESTAMP(3),
    "supplyTypeCode" VARCHAR(2),
    "subSupplyType" VARCHAR(2),
    "documentType" VARCHAR(3),
    "fromPincode" VARCHAR(6),
    "toPincode" VARCHAR(6),
    "distanceKm" INTEGER,
    "transportMode" "TransportMode" NOT NULL DEFAULT 'ROAD',
    "transporterName" TEXT,
    "transporterGstin" VARCHAR(15),
    "transporterDocNo" TEXT,
    "transporterDocDate" TIMESTAMP(3),
    "vehicleNumber" VARCHAR(15),
    "vehicleType" VARCHAR(1),
    "grossWeightKg" DECIMAL(12,3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancellationDeadline" TIMESTAMP(3),
    "apiRequestPayload" JSONB,
    "apiResponsePayload" JSONB,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eway_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "printer_profiles" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "paperWidth" "PaperWidth" NOT NULL DEFAULT 'MM_80',
    "connection" "PrinterConnection" NOT NULL DEFAULT 'USB',
    "ipAddress" TEXT,
    "port" INTEGER DEFAULT 9100,
    "deviceName" TEXT,
    "macAddress" TEXT,
    "codePage" INTEGER NOT NULL DEFAULT 0,
    "charactersPerLine" INTEGER NOT NULL DEFAULT 48,
    "cutAfterPrint" BOOLEAN NOT NULL DEFAULT true,
    "openCashDrawer" BOOLEAN NOT NULL DEFAULT false,
    "copies" INTEGER NOT NULL DEFAULT 1,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "printer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "businesses_gstin_key" ON "businesses"("gstin");

-- CreateIndex
CREATE INDEX "businesses_gstin_idx" ON "businesses"("gstin");

-- CreateIndex
CREATE INDEX "users_businessId_isActive_idx" ON "users"("businessId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "users_businessId_email_key" ON "users"("businessId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "users_businessId_phone_key" ON "users"("businessId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refreshTokenHash_key" ON "sessions"("refreshTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_replacedBySessionId_key" ON "sessions"("replacedBySessionId");

-- CreateIndex
CREATE INDEX "sessions_userId_revokedAt_idx" ON "sessions"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_userId_idx" ON "password_reset_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_tokenHash_key" ON "verification_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "verification_tokens_userId_channel_idx" ON "verification_tokens"("userId", "channel");

-- CreateIndex
CREATE INDEX "login_attempts_identifier_createdAt_idx" ON "login_attempts"("identifier", "createdAt");

-- CreateIndex
CREATE INDEX "login_attempts_ipAddress_createdAt_idx" ON "login_attempts"("ipAddress", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_businessId_createdAt_idx" ON "audit_logs"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "parties_businessId_partyType_isActive_idx" ON "parties"("businessId", "partyType", "isActive");

-- CreateIndex
CREATE INDEX "parties_businessId_gstin_idx" ON "parties"("businessId", "gstin");

-- CreateIndex
CREATE INDEX "parties_businessId_phone_idx" ON "parties"("businessId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "parties_businessId_displayName_key" ON "parties"("businessId", "displayName");

-- CreateIndex
CREATE INDEX "party_rates_partyId_productId_idx" ON "party_rates"("partyId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "party_rates_partyId_productId_unitId_effectiveFrom_key" ON "party_rates"("partyId", "productId", "unitId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "units_businessId_symbol_key" ON "units"("businessId", "symbol");

-- CreateIndex
CREATE UNIQUE INDEX "hsn_codes_businessId_code_key" ON "hsn_codes"("businessId", "code");

-- CreateIndex
CREATE INDEX "hsn_tax_rates_hsnCodeId_effectiveFrom_effectiveTo_idx" ON "hsn_tax_rates"("hsnCodeId", "effectiveFrom", "effectiveTo");

-- CreateIndex
CREATE UNIQUE INDEX "hsn_tax_rates_hsnCodeId_effectiveFrom_key" ON "hsn_tax_rates"("hsnCodeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "products_businessId_isActive_idx" ON "products"("businessId", "isActive");

-- CreateIndex
CREATE INDEX "products_businessId_hsnCodeId_idx" ON "products"("businessId", "hsnCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "products_businessId_name_key" ON "products"("businessId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "product_units_productId_unitId_key" ON "product_units"("productId", "unitId");

-- CreateIndex
CREATE INDEX "product_stocks_businessId_idx" ON "product_stocks"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "number_sequences_businessId_documentType_financialYear_key" ON "number_sequences"("businessId", "documentType", "financialYear");

-- CreateIndex
CREATE INDEX "sales_invoices_businessId_invoiceDate_idx" ON "sales_invoices"("businessId", "invoiceDate");

-- CreateIndex
CREATE INDEX "sales_invoices_businessId_partyId_status_idx" ON "sales_invoices"("businessId", "partyId", "status");

-- CreateIndex
CREATE INDEX "sales_invoices_businessId_status_idx" ON "sales_invoices"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoices_businessId_financialYear_invoiceNumber_key" ON "sales_invoices"("businessId", "financialYear", "invoiceNumber");

-- CreateIndex
CREATE INDEX "sales_invoice_items_productId_idx" ON "sales_invoice_items"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoice_items_invoiceId_lineNumber_key" ON "sales_invoice_items"("invoiceId", "lineNumber");

-- CreateIndex
CREATE INDEX "purchase_invoices_businessId_supplierInvoiceDate_idx" ON "purchase_invoices"("businessId", "supplierInvoiceDate");

-- CreateIndex
CREATE INDEX "purchase_invoices_businessId_partyId_idx" ON "purchase_invoices"("businessId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_invoices_businessId_purchaseNumber_key" ON "purchase_invoices"("businessId", "purchaseNumber");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_invoices_businessId_partyId_supplierInvoiceNumber_key" ON "purchase_invoices"("businessId", "partyId", "supplierInvoiceNumber");

-- CreateIndex
CREATE INDEX "purchase_invoice_items_productId_idx" ON "purchase_invoice_items"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_invoice_items_invoiceId_lineNumber_key" ON "purchase_invoice_items"("invoiceId", "lineNumber");

-- CreateIndex
CREATE INDEX "credit_debit_notes_businessId_noteDate_idx" ON "credit_debit_notes"("businessId", "noteDate");

-- CreateIndex
CREATE INDEX "credit_debit_notes_businessId_partyId_idx" ON "credit_debit_notes"("businessId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_debit_notes_businessId_financialYear_noteNumber_key" ON "credit_debit_notes"("businessId", "financialYear", "noteNumber");

-- CreateIndex
CREATE UNIQUE INDEX "credit_debit_note_items_noteId_lineNumber_key" ON "credit_debit_note_items"("noteId", "lineNumber");

-- CreateIndex
CREATE UNIQUE INDEX "payments_chequeId_key" ON "payments"("chequeId");

-- CreateIndex
CREATE INDEX "payments_businessId_paymentDate_idx" ON "payments"("businessId", "paymentDate");

-- CreateIndex
CREATE INDEX "payments_businessId_partyId_direction_idx" ON "payments"("businessId", "partyId", "direction");

-- CreateIndex
CREATE UNIQUE INDEX "payments_businessId_voucherNumber_key" ON "payments"("businessId", "voucherNumber");

-- CreateIndex
CREATE INDEX "payment_allocations_paymentId_idx" ON "payment_allocations"("paymentId");

-- CreateIndex
CREATE INDEX "payment_allocations_salesInvoiceId_idx" ON "payment_allocations"("salesInvoiceId");

-- CreateIndex
CREATE INDEX "payment_allocations_purchaseInvoiceId_idx" ON "payment_allocations"("purchaseInvoiceId");

-- CreateIndex
CREATE INDEX "cheques_businessId_status_chequeDate_idx" ON "cheques"("businessId", "status", "chequeDate");

-- CreateIndex
CREATE UNIQUE INDEX "cheques_businessId_partyId_chequeNumber_key" ON "cheques"("businessId", "partyId", "chequeNumber");

-- CreateIndex
CREATE INDEX "ledger_entries_businessId_partyId_entryDate_idx" ON "ledger_entries"("businessId", "partyId", "entryDate");

-- CreateIndex
CREATE INDEX "ledger_entries_businessId_entryDate_idx" ON "ledger_entries"("businessId", "entryDate");

-- CreateIndex
CREATE INDEX "ledger_entries_voucherType_voucherId_idx" ON "ledger_entries"("voucherType", "voucherId");

-- CreateIndex
CREATE INDEX "stock_movements_businessId_productId_movementDate_idx" ON "stock_movements"("businessId", "productId", "movementDate");

-- CreateIndex
CREATE INDEX "stock_movements_referenceType_referenceId_idx" ON "stock_movements"("referenceType", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "eway_bills_salesInvoiceId_key" ON "eway_bills"("salesInvoiceId");

-- CreateIndex
CREATE INDEX "eway_bills_businessId_status_idx" ON "eway_bills"("businessId", "status");

-- CreateIndex
CREATE INDEX "eway_bills_ewbNumber_idx" ON "eway_bills"("ewbNumber");

-- CreateIndex
CREATE UNIQUE INDEX "printer_profiles_businessId_name_key" ON "printer_profiles"("businessId", "name");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parties" ADD CONSTRAINT "parties_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_balances" ADD CONSTRAINT "party_balances_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_rates" ADD CONSTRAINT "party_rates_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_rates" ADD CONSTRAINT "party_rates_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_rates" ADD CONSTRAINT "party_rates_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hsn_codes" ADD CONSTRAINT "hsn_codes_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hsn_tax_rates" ADD CONSTRAINT "hsn_tax_rates_hsnCodeId_fkey" FOREIGN KEY ("hsnCodeId") REFERENCES "hsn_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_hsnCodeId_fkey" FOREIGN KEY ("hsnCodeId") REFERENCES "hsn_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_baseUnitId_fkey" FOREIGN KEY ("baseUnitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_stocks" ADD CONSTRAINT "product_stocks_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_stocks" ADD CONSTRAINT "product_stocks_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_items" ADD CONSTRAINT "sales_invoice_items_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "sales_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_items" ADD CONSTRAINT "sales_invoice_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_items" ADD CONSTRAINT "purchase_invoice_items_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "purchase_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_items" ADD CONSTRAINT "purchase_invoice_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_debit_notes" ADD CONSTRAINT "credit_debit_notes_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_debit_notes" ADD CONSTRAINT "credit_debit_notes_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_debit_notes" ADD CONSTRAINT "credit_debit_notes_againstSalesInvoiceId_fkey" FOREIGN KEY ("againstSalesInvoiceId") REFERENCES "sales_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_debit_notes" ADD CONSTRAINT "credit_debit_notes_againstPurchaseInvoiceId_fkey" FOREIGN KEY ("againstPurchaseInvoiceId") REFERENCES "purchase_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_debit_notes" ADD CONSTRAINT "credit_debit_notes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_debit_note_items" ADD CONSTRAINT "credit_debit_note_items_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "credit_debit_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_debit_note_items" ADD CONSTRAINT "credit_debit_note_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_chequeId_fkey" FOREIGN KEY ("chequeId") REFERENCES "cheques"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_salesInvoiceId_fkey" FOREIGN KEY ("salesInvoiceId") REFERENCES "sales_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_purchaseInvoiceId_fkey" FOREIGN KEY ("purchaseInvoiceId") REFERENCES "purchase_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cheques" ADD CONSTRAINT "cheques_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cheques" ADD CONSTRAINT "cheques_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_salesInvoiceId_fkey" FOREIGN KEY ("salesInvoiceId") REFERENCES "sales_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "printer_profiles" ADD CONSTRAINT "printer_profiles_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

