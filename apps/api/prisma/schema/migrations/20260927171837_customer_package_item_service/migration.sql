-- AddForeignKey
ALTER TABLE "customer_package_items" ADD CONSTRAINT "customer_package_items_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
