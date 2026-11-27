CREATE INDEX card_payments_member_created_id ON card_payments (user_id, created_at DESC, id DESC);
CREATE INDEX journal_sender_activity_created_id ON journals (sender_id, created_at DESC, id DESC)
  WHERE kind IN ('member_transfer','sandbox_credit');
CREATE INDEX journal_recipient_activity_created_id ON journals (recipient_id, created_at DESC, id DESC)
  WHERE kind IN ('member_transfer','sandbox_credit');
