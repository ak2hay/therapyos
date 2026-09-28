import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:razorpay_flutter/razorpay_flutter.dart';

import '../core/api_client.dart';
import '../core/format.dart';
import '../core/widgets.dart';

/// Completes a gateway order returned by `/portal/purchase` or `/portal/invoices/:id/pay`.
///
/// Mock orders (development) are settled through the API; real Razorpay orders open the native checkout
/// and the signed result is verified server-side before anything is marked paid.
class PaymentService {
  PaymentService(this.api);
  final ApiClient api;

  /// Returns true when the invoice was paid, false when the customer backed out.
  Future<bool> pay(BuildContext context, Map<String, dynamic> order, {required String businessName}) async {
    final amount = money(order['amount'] as num, currency: order['currency'] as String? ?? 'INR');
    if (order['mock'] == true) {
      final ok = await confirm(context, title: 'Test payment', message: 'Payments are in test mode. Simulate a successful payment of $amount for ${order['invoiceNumber']}?', action: 'Pay $amount');
      if (!ok) return false;
      await api.post('/portal/payments/${order['paymentId']}/mock-complete');
      return true;
    }
    if (kIsWeb) {
      throw ApiException('UNSUPPORTED', 'Online payment is available in the mobile app. You can also pay at the centre.');
    }

    final result = Completer<Map<String, String>?>();
    final razorpay = Razorpay();
    razorpay.on(Razorpay.EVENT_PAYMENT_SUCCESS, (PaymentSuccessResponse r) {
      if (!result.isCompleted) result.complete({'razorpay_order_id': r.orderId ?? '', 'razorpay_payment_id': r.paymentId ?? '', 'razorpay_signature': r.signature ?? ''});
    });
    razorpay.on(Razorpay.EVENT_PAYMENT_ERROR, (PaymentFailureResponse r) {
      if (result.isCompleted) return;
      if (r.code == Razorpay.PAYMENT_CANCELLED) return result.complete(null);
      result.completeError(ApiException('PAYMENT_FAILED', r.message ?? 'The payment did not go through. You have not been charged.'));
    });
    razorpay.on(Razorpay.EVENT_EXTERNAL_WALLET, (ExternalWalletResponse _) {});
    try {
      razorpay.open({
        'key': order['keyId'],
        'order_id': order['orderId'],
        'amount': order['amountMinor'],
        'currency': order['currency'],
        'name': businessName,
        'description': 'Invoice ${order['invoiceNumber']}',
        'prefill': order['prefill'] ?? const {},
      });
      final signed = await result.future;
      if (signed == null) return false;
      await api.post('/portal/payments/verify', signed);
      return true;
    } finally {
      razorpay.clear();
    }
  }
}
