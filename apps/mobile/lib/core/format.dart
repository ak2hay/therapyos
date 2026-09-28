import 'package:intl/intl.dart';

String money(num? value, {String currency = 'INR'}) {
  final v = value ?? 0;
  final whole = v == v.roundToDouble();
  final symbol = currency == 'INR' ? '₹' : '$currency ';
  return NumberFormat.currency(locale: 'en_IN', symbol: symbol, decimalDigits: whole ? 0 : 2).format(v);
}

DateTime? parseDate(Object? v) => v is String && v.isNotEmpty ? DateTime.tryParse(v)?.toLocal() : null;

/// `2026-09-30` → `Wed, 30 Sep`.
String dayLabel(String isoDate) {
  final d = DateTime.tryParse(isoDate);
  if (d == null) return isoDate;
  final today = DateTime.now();
  final t = DateTime(today.year, today.month, today.day);
  final diff = DateTime(d.year, d.month, d.day).difference(t).inDays;
  if (diff == 0) return 'Today';
  if (diff == 1) return 'Tomorrow';
  if (diff == -1) return 'Yesterday';
  return DateFormat('EEE, d MMM').format(d);
}

String dateLabel(DateTime? d) => d == null ? '—' : DateFormat('d MMM yyyy').format(d);

String timeLabel(String hhmm) {
  final parts = hhmm.split(':');
  if (parts.length < 2) return hhmm;
  final h = int.tryParse(parts[0]) ?? 0;
  final m = parts[1];
  final suffix = h < 12 ? 'AM' : 'PM';
  final h12 = h % 12 == 0 ? 12 : h % 12;
  return '$h12:$m $suffix';
}

String isoDate(DateTime d) => DateFormat('yyyy-MM-dd').format(d);

String duration(int seconds) {
  final s = seconds < 0 ? 0 : seconds;
  final h = s ~/ 3600;
  final m = (s % 3600) ~/ 60;
  final sec = s % 60;
  String two(int n) => n.toString().padLeft(2, '0');
  return h > 0 ? '$h:${two(m)}:${two(sec)}' : '${two(m)}:${two(sec)}';
}

String titleCase(String value) => value
    .toLowerCase()
    .split(RegExp(r'[_\s]+'))
    .where((w) => w.isNotEmpty)
    .map((w) => '${w[0].toUpperCase()}${w.substring(1)}')
    .join(' ');

String initials(String name) {
  final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
  if (parts.isEmpty) return '?';
  return (parts.first[0] + (parts.length > 1 ? parts.last[0] : '')).toUpperCase();
}
