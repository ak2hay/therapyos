import { Body, Controller, Get, Global, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FeatureFlagKey, PERMISSIONS } from '@therapyos/types';
import {
  inventoryQuery,
  inventoryTxnQuery,
  productCategorySchema,
  productQuery,
  productSchema,
  ProductInput,
  purchaseQuery,
  purchaseSchema,
  PurchaseInput,
  reorderLevelSchema,
  stockAdjustSchema,
  StockAdjustInput,
  transferQuery,
  transferSchema,
  TransferInput,
} from '@therapyos/validation';
import { z } from 'zod';
import { RequireAnyPermission, RequireFeature, RequirePermissions } from '../../common/decorators';
import { Zod } from '../../common/pipes/zod.pipe';
import { InventoryService } from './inventory.service';

/** The product catalogue is shared by POS retail, service consumables and inventory. */
@ApiTags('Inventory')
@ApiBearerAuth()
@Controller()
export class ProductsController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('product-categories')
  @RequireAnyPermission(PERMISSIONS.INVENTORY_READ, PERMISSIONS.PRODUCT_MANAGE, PERMISSIONS.POS_USE, PERMISSIONS.SERVICE_MANAGE)
  categories() {
    return this.inventory.listCategories();
  }

  @Post('product-categories')
  @RequirePermissions(PERMISSIONS.PRODUCT_MANAGE)
  createCategory(@Body(Zod(productCategorySchema)) body: z.infer<typeof productCategorySchema>) {
    return this.inventory.createCategory(body.name);
  }

  @Get('products')
  @RequireAnyPermission(PERMISSIONS.INVENTORY_READ, PERMISSIONS.PRODUCT_MANAGE, PERMISSIONS.POS_USE, PERMISSIONS.SERVICE_MANAGE, PERMISSIONS.OFFER_MANAGE, PERMISSIONS.SESSION_MANAGE)
  list(@Query(Zod(productQuery)) q: z.infer<typeof productQuery>) {
    return this.inventory.listProducts(q);
  }

  @Get('products/:id')
  @RequireAnyPermission(PERMISSIONS.INVENTORY_READ, PERMISSIONS.PRODUCT_MANAGE)
  get(@Param('id') id: string) {
    return this.inventory.getProduct(id);
  }

  @Post('products')
  @RequirePermissions(PERMISSIONS.PRODUCT_MANAGE)
  create(@Body(Zod(productSchema)) body: ProductInput) {
    return this.inventory.createProduct(body);
  }

  @Patch('products/:id')
  @RequirePermissions(PERMISSIONS.PRODUCT_MANAGE)
  update(@Param('id') id: string, @Body(Zod(productSchema.partial())) body: Partial<ProductInput>) {
    return this.inventory.updateProduct(id, body);
  }
}

@ApiTags('Inventory')
@ApiBearerAuth()
@RequireFeature(FeatureFlagKey.INVENTORY_ENABLED)
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('stock')
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  stock(@Query(Zod(inventoryQuery)) q: z.infer<typeof inventoryQuery>) {
    return this.inventory.stock(q);
  }

  @Get('low-stock')
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  lowStock(@Query('branchId') branchId?: string) {
    return this.inventory.lowStock(branchId || undefined);
  }

  @Get('transactions')
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  transactions(@Query(Zod(inventoryTxnQuery)) q: z.infer<typeof inventoryTxnQuery>) {
    return this.inventory.transactions(q);
  }

  @Post('adjustments')
  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  adjust(@Body(Zod(stockAdjustSchema)) body: StockAdjustInput) {
    return this.inventory.adjust(body);
  }

  @Post('reorder-level')
  @RequirePermissions(PERMISSIONS.INVENTORY_ADJUST)
  reorder(@Body(Zod(reorderLevelSchema)) body: z.infer<typeof reorderLevelSchema>) {
    return this.inventory.setReorderLevel(body.branchId, body.productId, body.reorderLevel);
  }

  @Get('purchases')
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  purchases(@Query(Zod(purchaseQuery)) q: z.infer<typeof purchaseQuery>) {
    return this.inventory.listPurchases(q);
  }

  @Post('purchases')
  @RequirePermissions(PERMISSIONS.INVENTORY_PURCHASE)
  purchase(@Body(Zod(purchaseSchema)) body: PurchaseInput) {
    return this.inventory.purchase(body);
  }

  @Get('transfers')
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  transfers(@Query(Zod(transferQuery)) q: z.infer<typeof transferQuery>) {
    return this.inventory.listTransfers(q);
  }

  @Get('transfers/:id')
  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  transfer(@Param('id') id: string) {
    return this.inventory.getTransfer(id);
  }

  @Post('transfers')
  @RequirePermissions(PERMISSIONS.INVENTORY_TRANSFER)
  requestTransfer(@Body(Zod(transferSchema)) body: TransferInput) {
    return this.inventory.requestTransfer(body);
  }

  @Post('transfers/:id/approve')
  @RequirePermissions(PERMISSIONS.INVENTORY_TRANSFER_APPROVE)
  approve(@Param('id') id: string) {
    return this.inventory.approveTransfer(id);
  }

  @Post('transfers/:id/receive')
  @RequirePermissions(PERMISSIONS.INVENTORY_TRANSFER)
  receive(@Param('id') id: string) {
    return this.inventory.receiveTransfer(id);
  }

  @Post('transfers/:id/reject')
  @RequirePermissions(PERMISSIONS.INVENTORY_TRANSFER_APPROVE)
  reject(@Param('id') id: string) {
    return this.inventory.closeTransfer(id, 'REJECTED');
  }

  @Post('transfers/:id/cancel')
  @RequirePermissions(PERMISSIONS.INVENTORY_TRANSFER)
  cancel(@Param('id') id: string) {
    return this.inventory.closeTransfer(id, 'CANCELLED');
  }
}

@Global()
@Module({ controllers: [ProductsController, InventoryController], providers: [InventoryService], exports: [InventoryService] })
export class InventoryModule {}
